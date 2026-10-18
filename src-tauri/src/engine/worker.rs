//! Thread dédié du moteur : il possède le backend llama.cpp (initialisé une seule fois), le
//! modèle chargé, et crée un contexte neuf à chaque génération. Les commandes arrivent par un
//! canal : modèle et contexte ne quittent jamais ce thread (pas de souci de durée de vie).

use std::num::NonZeroU32;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{Receiver, Sender};

use llama_cpp_2::context::params::{KvCacheType, LlamaContextParams};
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{LlamaChatMessage, LlamaChatTemplate, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::{LlamaBackendDeviceType, list_llama_ggml_backend_devices};

use super::gguf;
use super::types::{CUDA_BUILD, CacheType, ChatMessage, GenerateResult, LoadConfig, Sampling, StopReason};
use super::utf8::Utf8Stream;
use super::{Shared, log};

/// Nombre de jetons récents pris en compte par la pénalité de répétition.
const PENALTY_LAST_N: i32 = 64;

/// Pile du thread du moteur : marge pour llama.cpp (modèles de chat Jinja, chargement), au-delà
/// des 2 Mo par défaut des threads Rust. Mémoire réservée, pas engagée.
const ENGINE_STACK: usize = 8 * 1024 * 1024;

pub(crate) struct GenerateJob {
  pub request_id: String,
  pub model_id: String,
  pub path: PathBuf,
  /// Options utilisées si le modèle doit être chargé.
  pub config: LoadConfig,
  pub messages: Vec<ChatMessage>,
  pub sampling: Sampling,
}

pub(crate) enum Command {
  Load { id: String, path: PathBuf, config: LoadConfig, reply: Sender<Result<(), String>> },
  Unload { reply: Sender<Result<(), String>> },
  Generate { job: Box<GenerateJob>, reply: Sender<Result<GenerateResult, String>> },
}

struct Loaded {
  id: String,
  config: LoadConfig,
  model: LlamaModel,
  /// Chargé sans aucun GPU (repli ou GPU absent) : le contexte n'utilise pas le GPU non plus.
  no_gpu: bool,
}

struct Worker {
  backend: LlamaBackend,
  gpu: bool,
  shared: Arc<Shared>,
  loaded: Option<Loaded>,
}

/// Démarre le thread du moteur. L'issue de l'initialisation est publiée dans `shared`.
pub(crate) fn spawn(shared: Arc<Shared>, rx: Receiver<Command>) {
  let s = shared.clone();
  let started = std::thread::Builder::new()
    .name("lucania-engine".into())
    .stack_size(ENGINE_STACK)
    .spawn(move || run(s, rx));
  if let Err(e) = started {
    shared.set_init(Err(format!("thread du moteur impossible à lancer : {e}")));
  }
}

fn run(shared: Arc<Shared>, rx: Receiver<Command>) {
  // Logs llama.cpp/ggml : tout sur stderr en debug ; avertissements et erreurs dans le journal
  // de session.
  crate::crashlog::install_llama_logs();
  let backend = match catch_unwind(LlamaBackend::init) {
    Ok(Ok(b)) => b,
    Ok(Err(e)) => return shared.set_init(Err(format!("initialisation de llama.cpp impossible : {e}"))),
    Err(_) => return shared.set_init(Err("initialisation de llama.cpp impossible".into())),
  };
  let gpu = detect_gpu(&backend);
  // Le runtime CUDA a pu remplacer le filtre d'exceptions natif : on le réinstalle.
  crate::crashlog::arm_exception_filter();
  log(&format!("backend : {} (build {})", if gpu { "cuda" } else { "cpu" }, if CUDA_BUILD { "cuda" } else { "cpu" }));
  shared.set_init(Ok(gpu));

  let mut worker = Worker { backend, gpu, shared, loaded: None };
  while let Ok(cmd) = rx.recv() {
    worker.handle(cmd);
  }
}

/// GPU utilisable : build CUDA, offload possible et au moins un périphérique GPU détecté.
fn detect_gpu(backend: &LlamaBackend) -> bool {
  if !CUDA_BUILD {
    return false;
  }
  let devices = list_llama_ggml_backend_devices();
  for d in &devices {
    log(&format!(
      "périphérique {} ({}) : {} - {} Mo libres",
      d.name,
      d.backend,
      d.description,
      d.memory_free / (1024 * 1024)
    ));
  }
  let has_gpu = devices
    .iter()
    .any(|d| matches!(d.device_type, LlamaBackendDeviceType::Gpu | LlamaBackendDeviceType::IntegratedGpu));
  let usable = has_gpu && backend.supports_gpu_offload();
  if !usable {
    log("build CUDA mais aucun GPU utilisable : les modèles seront chargés sur le CPU");
  }
  usable
}

fn kv_type(t: CacheType) -> KvCacheType {
  match t {
    CacheType::F16 => KvCacheType::F16,
    CacheType::Q8_0 => KvCacheType::Q8_0,
    CacheType::Q4_0 => KvCacheType::Q4_0,
  }
}

fn context_params(config: &LoadConfig, no_gpu: bool) -> LlamaContextParams {
  // Un cache V quantifié exige Flash Attention : on l'active alors d'office.
  let flash = config.flash_attn || config.cache_type_v != CacheType::F16;
  let threads = i32::try_from(config.n_threads).unwrap_or(1).max(1);
  let params = LlamaContextParams::default()
    .with_n_ctx(NonZeroU32::new(config.n_ctx))
    .with_n_batch(config.n_batch)
    .with_n_ubatch(config.n_batch.min(512))
    .with_n_threads(threads)
    .with_n_threads_batch(threads)
    .with_flash_attention_policy(if flash {
      llama_cpp_sys_2::LLAMA_FLASH_ATTN_TYPE_ENABLED
    } else {
      llama_cpp_sys_2::LLAMA_FLASH_ATTN_TYPE_DISABLED
    })
    .with_type_k(kv_type(config.cache_type_k))
    .with_type_v(kv_type(config.cache_type_v));
  if no_gpu {
    params.with_offload_kqv(false).with_op_offload(false)
  } else {
    params
  }
}

impl Worker {
  fn handle(&mut self, cmd: Command) {
    match cmd {
      Command::Load { id, path, config, reply } => {
        let r = self.guarded(|w| w.load(&id, &path, &config));
        if let Err(e) = &r {
          log(&format!("échec du chargement de « {id} » : {e}"));
        }
        let _ = reply.send(r);
      }
      Command::Unload { reply } => {
        let r = self.guarded(|w| {
          w.loaded = None;
          w.shared.set_status(|s| s.loaded_model = None);
          Ok(())
        });
        let _ = reply.send(r);
      }
      Command::Generate { job, reply } => {
        // Jamais le contenu des messages : seulement leur nombre et le résultat.
        log(&format!("génération {} avec « {} » : début ({} messages)", job.request_id, job.model_id, job.messages.len()));
        let start = std::time::Instant::now();
        let r = self.guarded(|w| w.generate(&job));
        match &r {
          Ok(g) => log(&format!(
            "génération {} : fin, {} jetons en {:.1} s ({:?})",
            job.request_id,
            g.tokens,
            start.elapsed().as_secs_f64(),
            g.stop_reason
          )),
          Err(e) => log(&format!("génération {} : erreur : {e}", job.request_id)),
        }
        let _ = reply.send(r);
      }
    }
  }

  /// Exécute une commande en interceptant une éventuelle panique : le thread survit, le modèle
  /// est déchargé par prudence.
  fn guarded<T>(&mut self, f: impl FnOnce(&mut Self) -> Result<T, String>) -> Result<T, String> {
    match catch_unwind(AssertUnwindSafe(|| f(self))) {
      Ok(r) => r,
      Err(_) => {
        self.loaded = None;
        self.shared.set_status(|s| *s = Default::default());
        Err("Erreur interne du moteur : le modèle a été déchargé.".into())
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Chargement
  // -------------------------------------------------------------------------------------------

  fn load(&mut self, id: &str, path: &Path, config: &LoadConfig) -> Result<(), String> {
    if let Some(l) = &self.loaded {
      if l.id == id && l.config == *config {
        return Ok(());
      }
    }
    // Libère d'abord l'ancien modèle (RAM/VRAM).
    self.loaded = None;
    self.shared.set_status(|s| {
      s.loaded_model = None;
      s.loading = true;
    });
    let result = self.load_inner(id, path, config);
    let loaded_id = result.as_ref().ok().map(|l| l.id.clone());
    let outcome = result.map(|l| self.loaded = Some(l));
    self.shared.set_status(|s| {
      s.loading = false;
      s.loaded_model = loaded_id;
    });
    outcome
  }

  fn load_inner(&self, id: &str, path: &Path, config: &LoadConfig) -> Result<Loaded, String> {
    // Refus propre des fichiers annexes (tête MTP, projecteur…) : llama.cpp peut les accepter
    // puis faire une violation d'accès à la création du contexte, non rattrapable.
    gguf::check_model(path)?;
    log(&format!("chargement de « {id} » ({}) : {config:?}", path.display()));
    let start = std::time::Instant::now();
    let loaded = self.load_devices(id, path, config)?;
    log(&format!(
      "« {id} » chargé en {:.1} s ({})",
      start.elapsed().as_secs_f64(),
      if loaded.no_gpu { "CPU seul".to_string() } else { format!("GPU, nGpuLayers {}", config.n_gpu_layers) }
    ));
    Ok(loaded)
  }

  fn load_devices(&self, id: &str, path: &Path, config: &LoadConfig) -> Result<Loaded, String> {
    if CUDA_BUILD && !self.gpu && config.n_gpu_layers > 0 {
      log("aucun GPU CUDA utilisable : chargement sur le CPU");
    }
    if self.gpu && config.n_gpu_layers > 0 {
      match self.try_load(id, path, config, false) {
        Ok(l) => return Ok(l),
        Err(e) => log(&format!("échec du chargement avec le GPU ({e}) : nouvel essai sur le CPU")),
      }
    }
    // Sans GPU utilisable (ou après échec) : aucun périphérique GPU. Avec un GPU utilisable et
    // nGpuLayers = 0, llama.cpp garde le droit d'accélérer certains calculs sur le GPU.
    let no_gpu = !self.gpu || config.n_gpu_layers > 0;
    self.try_load(id, path, config, no_gpu)
  }

  fn try_load(&self, id: &str, path: &Path, config: &LoadConfig, no_gpu: bool) -> Result<Loaded, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut params = LlamaModelParams::default().with_n_gpu_layers(if no_gpu { 0 } else { config.n_gpu_layers });
    if no_gpu {
      // Liste de périphériques vide = aucun GPU (équivalent de `--device none`).
      params = params.with_devices(&[]).map_err(|e| format!("Paramètres de chargement invalides : {e}"))?;
    }
    let model = LlamaModel::load_from_file(&self.backend, path, &params).map_err(|_| {
      format!("Impossible de charger « {name} » (fichier GGUF invalide, architecture non prise en charge ou mémoire insuffisante).")
    })?;
    // Contexte d'essai : vérifie dès le chargement que n_ctx et le cache tiennent en mémoire.
    model.new_context(&self.backend, context_params(config, no_gpu)).map_err(|_| {
      format!(
        "Contexte de {} jetons impossible à créer pour « {name} » (mémoire insuffisante ? Réduisez nCtx).",
        config.n_ctx
      )
    })?;
    Ok(Loaded { id: id.to_string(), config: config.clone(), model, no_gpu })
  }

  // -------------------------------------------------------------------------------------------
  // Génération
  // -------------------------------------------------------------------------------------------

  fn generate(&mut self, job: &GenerateJob) -> Result<GenerateResult, String> {
    self.shared.set_status(|s| s.generating = true);
    let result = self.generate_inner(job);
    self.shared.set_status(|s| s.generating = false);
    result
  }

  fn generate_inner(&mut self, job: &GenerateJob) -> Result<GenerateResult, String> {
    if self.loaded.as_ref().is_none_or(|l| l.id != job.model_id) {
      self.load(&job.model_id, &job.path, &job.config)?;
    }
    if self.stopped() {
      return Ok(GenerateResult { content: String::new(), tokens: 0, stop_reason: StopReason::Stopped });
    }
    let loaded = self.loaded.as_ref().ok_or("Aucun modèle chargé.")?;
    let prompt = build_prompt(&loaded.model, &job.messages)?;
    let ctx = loaded
      .model
      .new_context(&self.backend, context_params(&loaded.config, loaded.no_gpu))
      .map_err(|_| "Création du contexte impossible (mémoire insuffisante ?).".to_string())?;
    self.run(&loaded.model, ctx, &prompt, &job.sampling, &job.request_id)
  }

  fn stopped(&self) -> bool {
    self.shared.stop.load(Ordering::SeqCst)
  }

  fn run(
    &self,
    model: &LlamaModel,
    mut ctx: LlamaContext<'_>,
    prompt: &str,
    sampling: &Sampling,
    request_id: &str,
  ) -> Result<GenerateResult, String> {
    let vocab = model.vocab();
    let mut tokens = vocab.tokenize(prompt.as_bytes(), true, true);
    // Certains modèles de chat écrivent déjà le BOS : on évite de le doubler.
    if tokens.len() >= 2 && tokens[0] == vocab.bos() && tokens[1] == vocab.bos() {
      tokens.remove(0);
    }
    if tokens.is_empty() {
      return Err("Le prompt est vide.".into());
    }
    let n_ctx = ctx.n_ctx() as usize;
    if tokens.len() >= n_ctx {
      return Err(format!(
        "Le prompt ({} jetons) dépasse le contexte du modèle ({n_ctx} jetons). Raccourcissez la conversation ou augmentez nCtx.",
        tokens.len()
      ));
    }

    // Prompt traité par lots de n_batch jetons ; seuls les logits du dernier jeton servent.
    let n_batch = (ctx.n_batch() as usize).max(1);
    let mut batch = LlamaBatch::new(n_batch, 1);
    let last = tokens.len() - 1;
    for (i, chunk) in tokens.chunks(n_batch).enumerate() {
      if self.stopped() {
        return Ok(GenerateResult { content: String::new(), tokens: 0, stop_reason: StopReason::Stopped });
      }
      batch.clear();
      for (j, &t) in chunk.iter().enumerate() {
        let pos = i * n_batch + j;
        batch.add(t, pos as i32, &[0], pos == last).map_err(|e| format!("Lot de jetons invalide : {e}"))?;
      }
      ctx.decode(&mut batch).map_err(|e| format!("Échec du traitement du prompt : {e}"))?;
    }

    // Chaîne : pénalité de répétition -> top_k -> top_p -> min_p -> température -> tirage.
    let mut sampler = LlamaSampler::chain_simple([
      LlamaSampler::penalties(vocab.n_tokens(), PENALTY_LAST_N, sampling.repeat_penalty, 0.0, 0.0),
      LlamaSampler::top_k(sampling.top_k),
      LlamaSampler::top_p(sampling.top_p, 1),
      LlamaSampler::min_p(sampling.min_p, 1),
      LlamaSampler::temp(sampling.temperature),
      LlamaSampler::dist(sampling.seed),
    ]);

    let mut n_cur = tokens.len();
    let mut generated: u32 = 0;
    let mut content = String::new();
    let mut utf8 = Utf8Stream::default();
    let mut piece = Vec::with_capacity(32);
    let stop_reason = loop {
      if self.stopped() {
        break StopReason::Stopped;
      }
      // `sample` applique la chaîne puis accepte le jeton (historique des pénalités).
      let token = sampler.sample(&ctx, batch.n_tokens() - 1);
      if vocab.is_eog(token) {
        break StopReason::Eos;
      }
      piece.clear();
      vocab.token_to_piece_into(token, &mut piece, false, None);
      let text = utf8.push(&piece);
      if !text.is_empty() {
        self.shared.emit_token(request_id, &text);
        content.push_str(&text);
      }
      generated += 1;
      // Limites : nombre de jetons demandé ou contexte plein.
      if generated >= sampling.max_tokens || n_cur >= n_ctx {
        break StopReason::MaxTokens;
      }
      batch.clear();
      batch.add(token, n_cur as i32, &[0], true).map_err(|e| format!("Lot de jetons invalide : {e}"))?;
      n_cur += 1;
      ctx.decode(&mut batch).map_err(|e| format!("Échec de la génération : {e}"))?;
    };
    let rest = utf8.finish();
    if !rest.is_empty() {
      self.shared.emit_token(request_id, &rest);
      content.push_str(&rest);
    }
    Ok(GenerateResult { content, tokens: generated, stop_reason })
  }
}

/// Met la conversation en forme avec le modèle de chat du GGUF ; repli ChatML s'il est absent
/// ou non reconnu par llama.cpp.
fn build_prompt(model: &LlamaModel, messages: &[ChatMessage]) -> Result<String, String> {
  let chat = messages
    .iter()
    .map(|m| LlamaChatMessage::new(m.role.clone(), m.content.replace('\0', "")))
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| format!("Message invalide : {e}"))?;
  match model.chat_template(None) {
    Ok(tmpl) => match model.apply_chat_template(&tmpl, &chat, true) {
      Ok(prompt) => return Ok(prompt),
      Err(e) => log(&format!("modèle de chat du GGUF non reconnu ({e}) : repli ChatML")),
    },
    Err(_) => log("pas de modèle de chat dans le GGUF : repli ChatML"),
  }
  let chatml = LlamaChatTemplate::new("chatml").map_err(|e| format!("Modèle ChatML invalide : {e}"))?;
  model
    .apply_chat_template(&chatml, &chat, true)
    .map_err(|e| format!("Mise en forme de la conversation impossible : {e}"))
}
