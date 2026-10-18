//! Moteur d'inférence intégré (llama.cpp via le crate `llama-cpp-2`).
//!
//! - `worker` : thread dédié qui possède le backend, le modèle et les contextes ;
//! - `commands` : commandes Tauri appelées par les pages (contrat JSON camelCase) ;
//! - `models` : dossier des modèles GGUF (liste, résolution sûre des identifiants) ;
//! - `gguf` : lecture de l'en-tête GGUF, refus des fichiers annexes avant llama.cpp ;
//! - `types` : structures échangées et réglages par défaut ;
//! - `profiles` : réglages enregistrés par modèle (`model-profiles.json`) ;
//! - `estimate` : estimation mémoire et choix automatique des couches GPU ;
//! - `utf8` : découpage UTF-8 correct du flux de jetons.
//!
//! `Engine` est la poignée partagée (clonable) : ses méthodes sont bloquantes et sont appelées
//! hors du thread principal par les commandes.

pub mod commands;
mod estimate;
pub(crate) mod gguf;
mod models;
mod profiles;
mod types;
mod utf8;
mod worker;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use tauri::Manager;

pub use estimate::VramEstimate;
pub use types::{
  ChatMessage, EngineInfo, EngineStatus, EstimateInput, GenParams, GenerateResult, LoadOptions, ModelEntry, ModelProfile, ProfileInfo,
  SaveResult, TokenEvent,
};
use profiles::ProfileStore;
use types::{CUDA_BUILD, Defaults, LoadConfig, Sampling};
use worker::{Command, GenerateJob};

/// Événements émis par le moteur (relayés aux pages par `commands::emitter`).
pub enum Event {
  Token(TokenEvent),
  Status(EngineStatus),
}

pub type EventSink = Box<dyn Fn(Event) + Send + Sync>;

/// Journal du moteur : stderr (invisible dans l'app installée, sans console) et journal de
/// session `logs-crash/session.log`.
pub(crate) fn log(msg: &str) {
  eprintln!("[moteur] {msg}");
  crate::crashlog::note(&format!("[moteur] {msg}"));
}

/// Verrou tolérant : un thread qui a paniqué ne bloque pas les suivants.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
  m.lock().unwrap_or_else(|e| e.into_inner())
}

const BUSY: &str = "Une génération est déjà en cours";
const IN_USE: &str = "Impossible de supprimer un modèle en cours d'utilisation.";

/// État partagé entre les commandes et le thread du moteur.
pub(crate) struct Shared {
  models_dir: PathBuf,
  status: Mutex<EngineStatus>,
  /// Demande d'arrêt de la génération en cours, lue à chaque jeton.
  stop: AtomicBool,
  /// Une génération est acceptée (de l'appel jusqu'à la réponse).
  busy: AtomicBool,
  current_request: Mutex<Option<String>>,
  /// Réglages enregistrés par modèle.
  profiles: Mutex<ProfileStore>,
  /// Modèle chargé et couches effectivement placées sur le GPU (tenu à jour par le worker).
  loaded_gpu: Mutex<Option<(String, u32)>>,
  /// Issue de l'initialisation du thread : Ok(gpu utilisable) ou message d'erreur.
  init: Mutex<Option<Result<bool, String>>>,
  init_cv: Condvar,
  sink: EventSink,
}

impl Shared {
  pub(crate) fn set_init(&self, r: Result<bool, String>) {
    if let Err(e) = &r {
      log(&format!("moteur indisponible : {e}"));
    }
    *lock(&self.init) = Some(r);
    self.init_cv.notify_all();
  }

  /// Attend la fin de l'initialisation (30 s au plus).
  fn wait_init(&self) -> Option<Result<bool, String>> {
    let guard = lock(&self.init);
    let (guard, _) = self
      .init_cv
      .wait_timeout_while(guard, Duration::from_secs(30), |v| v.is_none())
      .unwrap_or_else(|e| e.into_inner());
    guard.clone()
  }

  /// Modifie le statut et l'émet s'il a changé.
  pub(crate) fn set_status(&self, f: impl FnOnce(&mut EngineStatus)) {
    let changed = {
      let mut s = lock(&self.status);
      let before = s.clone();
      f(&mut s);
      (*s != before).then(|| s.clone())
    };
    if let Some(snapshot) = changed {
      (self.sink)(Event::Status(snapshot));
    }
  }

  pub(crate) fn emit_token(&self, request_id: &str, text: &str) {
    (self.sink)(Event::Token(TokenEvent { request_id: request_id.to_string(), text: text.to_string() }));
  }

  fn down_error(&self) -> String {
    match &*lock(&self.init) {
      Some(Err(e)) => format!("Moteur indisponible : {e}"),
      _ => "Le moteur s'est arrêté de façon inattendue.".into(),
    }
  }
}

/// Libère la réservation de génération quoi qu'il arrive.
struct BusyGuard<'a>(&'a Shared);

impl Drop for BusyGuard<'_> {
  fn drop(&mut self) {
    *lock(&self.0.current_request) = None;
    self.0.busy.store(false, Ordering::SeqCst);
  }
}

#[derive(Clone)]
pub struct Engine {
  shared: Arc<Shared>,
  tx: Sender<Command>,
}

impl Engine {
  /// Démarre le thread du moteur. `models_dir` doit déjà exister (sinon la liste est vide) ;
  /// `profiles_file` : fichier des réglages par modèle (absent = aucun réglage).
  pub fn start(models_dir: PathBuf, profiles_file: PathBuf, sink: EventSink) -> Engine {
    let shared = Arc::new(Shared {
      models_dir,
      status: Mutex::new(EngineStatus::default()),
      stop: AtomicBool::new(false),
      busy: AtomicBool::new(false),
      current_request: Mutex::new(None),
      profiles: Mutex::new(ProfileStore::open(profiles_file)),
      loaded_gpu: Mutex::new(None),
      init: Mutex::new(None),
      init_cv: Condvar::new(),
      sink,
    });
    let (tx, rx) = mpsc::channel();
    worker::spawn(shared.clone(), rx);
    Engine { shared, tx }
  }

  fn call<T>(&self, make: impl FnOnce(Sender<Result<T, String>>) -> Command) -> Result<T, String> {
    let (reply, rx) = mpsc::channel();
    self.tx.send(make(reply)).map_err(|_| self.shared.down_error())?;
    rx.recv().map_err(|_| self.shared.down_error())?
  }

  pub fn info(&self) -> EngineInfo {
    let gpu = matches!(self.shared.wait_init(), Some(Ok(true)));
    EngineInfo {
      backend: if gpu { "cuda" } else { "cpu" },
      models_dir: self.shared.models_dir.to_string_lossy().into_owned(),
    }
  }

  pub fn list_models(&self) -> Result<Vec<ModelEntry>, String> {
    models::list_models(&self.shared.models_dir)
  }

  pub fn status(&self) -> EngineStatus {
    lock(&self.shared.status).clone()
  }

  /// Options absentes : celles du profil du modèle.
  pub fn load(&self, model_id: String, options: Option<LoadOptions>) -> Result<(), String> {
    let path = models::resolve_model(&self.shared.models_dir, &model_id)?;
    let options = options.unwrap_or_else(|| self.profile(&model_id).load);
    let config = LoadConfig::from_options(&options);
    self.call(|reply| Command::Load { id: model_id, path, config, reply })
  }

  pub fn unload(&self) -> Result<(), String> {
    self.call(|reply| Command::Unload { reply })
  }

  pub fn generate(
    &self,
    request_id: String,
    model_id: String,
    messages: Vec<ChatMessage>,
    params: Option<GenParams>,
  ) -> Result<GenerateResult, String> {
    if messages.is_empty() {
      return Err("Aucun message à envoyer.".into());
    }
    if let Some(m) = messages.iter().find(|m| !matches!(m.role.as_str(), "system" | "user" | "assistant")) {
      return Err(format!("Rôle de message invalide : « {} » (system, user ou assistant).", m.role));
    }
    let path = models::resolve_model(&self.shared.models_dir, &model_id)?;
    let profile = self.profile(&model_id);
    let (messages, sampling) = prepare(messages, params.unwrap_or_default(), &profile.generation);

    if self.shared.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
      return Err(BUSY.into());
    }
    let _guard = BusyGuard(&self.shared);
    self.shared.stop.store(false, Ordering::SeqCst);
    *lock(&self.shared.current_request) = Some(request_id.clone());

    // Utilisée seulement si le modèle n'est pas déjà chargé (sinon : sa configuration actuelle).
    let config = LoadConfig::from_options(&profile.load);
    let job = Box::new(GenerateJob { request_id, model_id, path, config, messages, sampling });
    self.call(|reply| Command::Generate { job, reply })
  }

  pub fn models_dir(&self) -> &Path {
    &self.shared.models_dir
  }

  /// Supprime un modèle (toutes ses parties s'il est découpé), après l'avoir déchargé s'il était
  /// chargé. Refusé pendant une génération ou un chargement qui le concerne.
  pub fn delete_model(&self, model_id: &str) -> Result<(), String> {
    let path = models::resolve_model(&self.shared.models_dir, model_id)?;
    // Réserve le moteur : aucune génération ne peut démarrer pendant la suppression.
    let reserved = self.shared.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok();
    let _guard = reserved.then(|| BusyGuard(&self.shared));
    let status = self.status();
    let is_loaded = status.loaded_model.as_deref() == Some(model_id);
    if !reserved && (is_loaded || status.loading) {
      return Err(IN_USE.into());
    }
    if is_loaded {
      self.call(|reply| Command::Unload { reply })?;
    }
    models::delete_model_files(&self.shared.models_dir, &path)?;
    if let Err(e) = lock(&self.shared.profiles).remove(model_id) {
      log(&format!("réglages de « {model_id} » non supprimés : {e}"));
    }
    Ok(())
  }

  // -------------------------------------------------------------------------------------------
  // Réglages par modèle
  // -------------------------------------------------------------------------------------------

  fn profile(&self, model_id: &str) -> ModelProfile {
    lock(&self.shared.profiles).get(model_id)
  }

  fn is_loaded(&self, model_id: &str) -> bool {
    self.status().loaded_model.as_deref() == Some(model_id)
  }

  /// GPU utilisable par llama.cpp (attend l'initialisation du moteur).
  fn gpu_usable(&self) -> bool {
    matches!(self.shared.wait_init(), Some(Ok(true)))
  }

  pub fn get_profile(&self, model_id: String) -> Result<ProfileInfo, String> {
    let path = models::resolve_model(&self.shared.models_dir, &model_id)?;
    let loaded_gpu_layers = lock(&self.shared.loaded_gpu).as_ref().filter(|(id, _)| *id == model_id).map(|(_, g)| *g);
    Ok(ProfileInfo {
      profile: self.profile(&model_id),
      defaults: Defaults::current(),
      meta: gguf::read_arch_meta(&path).ok(),
      size_bytes: models::model_size(&path),
      loaded: self.is_loaded(&model_id),
      loaded_gpu_layers,
      gpu_build: CUDA_BUILD,
      model_id,
    })
  }

  /// Enregistre le profil (validé) sans recharger le modèle.
  pub fn set_profile(&self, model_id: String, profile: ModelProfile) -> Result<SaveResult, String> {
    models::resolve_model(&self.shared.models_dir, &model_id)?;
    let new_load = LoadConfig::from_options(&profile.load);
    let old = lock(&self.shared.profiles).set(&model_id, profile)?;
    Ok(SaveResult { load_changed: LoadConfig::from_options(&old.load) != new_load, loaded: self.is_loaded(&model_id) })
  }

  pub fn reset_profile(&self, model_id: String) -> Result<SaveResult, String> {
    let old = lock(&self.shared.profiles).remove(&model_id)?;
    Ok(SaveResult { load_changed: LoadConfig::from_options(&old.load) != LoadConfig::default(), loaded: self.is_loaded(&model_id) })
  }

  /// Estimation mémoire d'un modèle installé (`modelId`) ou décrit (`meta` + `sizeBytes`).
  pub fn estimate(&self, input: EstimateInput) -> Result<VramEstimate, String> {
    let (size, meta, options) = match input.model_id {
      Some(id) => {
        let path = models::resolve_model(&self.shared.models_dir, &id)?;
        let meta = gguf::read_arch_meta(&path)?;
        (models::model_size(&path), meta, input.options.unwrap_or_else(|| self.profile(&id).load))
      }
      None => match (input.meta, input.size_bytes) {
        (Some(meta), Some(size)) => (size, meta, input.options.unwrap_or_default()),
        _ => return Err("Estimation impossible : indiquez modelId, ou meta et sizeBytes.".into()),
      },
    };
    let vram = match input.vram_bytes {
      Some(v) => v,
      None if self.gpu_usable() => worker::best_gpu_memory().0,
      None => 0,
    };
    let config = LoadConfig::from_options(&options);
    Ok(estimate::estimate(size, &meta, &config, vram, input.ram_bytes.unwrap_or(0)))
  }

  /// Arrête la génération en cours ; sans effet si `request_id` désigne une autre requête.
  pub fn stop(&self, request_id: Option<&str>) {
    if !self.shared.busy.load(Ordering::SeqCst) {
      return;
    }
    let current = lock(&self.shared.current_request);
    if let (Some(wanted), Some(cur)) = (request_id, current.as_deref()) {
      if wanted != cur {
        return;
      }
    }
    self.shared.stop.store(true, Ordering::SeqCst);
  }
}

/// Fusionne les paramètres de la requête avec le profil du modèle (sauf `useProfile: false`) :
/// champ absent -> profil -> défaut. Le prompt système retenu passe en tête de la conversation.
fn prepare(mut messages: Vec<ChatMessage>, params: GenParams, profile: &GenParams) -> (Vec<ChatMessage>, Sampling) {
  let params = if params.use_profile == Some(false) { params } else { params.or(profile) };
  profiles::apply_system_prompt(&mut messages, params.system_prompt.as_deref());
  (messages, Sampling::from_params(&params))
}

/// Crée le dossier des modèles et démarre le moteur (appelé depuis `setup`).
pub fn setup(app: &tauri::App) {
  let base = app
    .path()
    .app_local_data_dir()
    .unwrap_or_else(|_| std::env::temp_dir().join("com.lucania.desktop"));
  let models_dir = base.join("models");
  if let Err(e) = std::fs::create_dir_all(&models_dir) {
    log(&format!("création du dossier des modèles impossible ({}) : {e}", models_dir.display()));
  }
  let engine = Engine::start(models_dir, base.join("model-profiles.json"), commands::emitter(app.handle().clone()));
  app.manage(engine);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn fusion_avec_profil() {
    let msg = |role: &str, content: &str| ChatMessage { role: role.into(), content: content.into() };
    let profile = GenParams { temperature: Some(0.1), max_tokens: Some(99), system_prompt: Some("Profil.".into()), ..Default::default() };
    let params = GenParams { max_tokens: Some(10), ..Default::default() };
    let (m, s) = prepare(vec![msg("system", "Conv."), msg("user", "Q")], params.clone(), &profile);
    assert_eq!(m[0].content, "Profil.\n\nConv.");
    assert_eq!((s.temperature, s.max_tokens), (0.1, 10));
    // Champ absent partout : défaut.
    assert_eq!(s.top_k, types::DEFAULT_TOP_K);
    // useProfile false : rien du profil.
    let off = GenParams { use_profile: Some(false), ..params };
    let (m, s) = prepare(vec![msg("user", "Q")], off, &profile);
    assert_eq!(m, vec![msg("user", "Q")]);
    assert_eq!((s.temperature, s.max_tokens), (types::DEFAULT_TEMPERATURE, 10));
  }

  /// Test manuel (ignoré par défaut) : génère quelques jetons avec un vrai GGUF.
  ///   LUCANIA_TEST_GGUF=C:\chemin\modele.gguf cargo test --lib engine -- --ignored --nocapture
  /// Le fichier peut ne pas porter l'extension .gguf (ex. blob Ollama) : le test contourne la
  /// résolution d'identifiant.
  #[test]
  #[ignore]
  fn generation_reelle() {
    let Ok(path) = std::env::var("LUCANIA_TEST_GGUF") else {
      eprintln!("LUCANIA_TEST_GGUF non défini : test ignoré");
      return;
    };
    let path = PathBuf::from(path);
    let streamed = Arc::new(Mutex::new(String::new()));
    let s2 = streamed.clone();
    let sink: EventSink = Box::new(move |ev| match ev {
      Event::Token(t) => lock(&s2).push_str(&t.text),
      Event::Status(s) => eprintln!("[statut] {s:?}"),
    });
    let profiles = std::env::temp_dir().join(format!("lucania-profiles-reel-{}.json", std::process::id()));
    let engine = Engine::start(std::env::temp_dir(), profiles, sink);
    let info = engine.info();
    eprintln!("backend = {}", info.backend);

    let messages = vec![ChatMessage { role: "user".into(), content: "Dis bonjour en une phrase.".into() }];
    let job = Box::new(GenerateJob {
      request_id: "test".into(),
      model_id: "test-model".into(),
      path,
      config: LoadConfig { n_ctx: 2048, ..LoadConfig::default() },
      messages,
      sampling: Sampling::from_params(&GenParams { max_tokens: Some(40), seed: Some(42), ..Default::default() }),
    });
    let start = std::time::Instant::now();
    let r = engine.call(|reply| Command::Generate { job, reply }).expect("génération");
    eprintln!("{} jetons en {:?}, arrêt {:?}\n---\n{}\n---", r.tokens, start.elapsed(), r.stop_reason, r.content);
    assert!(r.tokens > 0);
    assert!(!r.content.trim().is_empty());
    assert_eq!(*lock(&streamed), r.content);
    assert_eq!(engine.status().loaded_model.as_deref(), Some("test-model"));
    assert!(!engine.status().generating);
  }
}
