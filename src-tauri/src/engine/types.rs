//! Types échangés avec les pages (JSON en camelCase) et réglages résolus du moteur.

use serde::{Deserialize, Serialize};

use super::gguf::ArchMeta;

/// Vrai si l'app est compilée avec la feature `cuda`.
pub const CUDA_BUILD: bool = cfg!(feature = "cuda");

// ---------------------------------------------------------------------------------------------
// Réponses
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
  /// "cuda" seulement si le build a la feature ET qu'un GPU est utilisable, sinon "cpu".
  pub backend: &'static str,
  pub models_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
  /// Chemin relatif au dossier des modèles, séparateurs "/".
  pub id: String,
  /// Nom du fichier sans ".gguf".
  pub name: String,
  pub size_bytes: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
  pub loaded_model: Option<String>,
  pub loading: bool,
  pub generating: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum StopReason {
  #[serde(rename = "eos")]
  Eos,
  #[serde(rename = "maxTokens")]
  MaxTokens,
  #[serde(rename = "stopped")]
  Stopped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateResult {
  pub content: String,
  /// Nombre de jetons générés (hors jeton de fin).
  pub tokens: u32,
  pub stop_reason: StopReason,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenEvent {
  pub request_id: String,
  pub text: String,
}

// ---------------------------------------------------------------------------------------------
// Entrées
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ChatMessage {
  pub role: String,
  pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CacheType {
  #[serde(rename = "f16")]
  F16,
  #[serde(rename = "q8_0")]
  Q8_0,
  #[serde(rename = "q4_0")]
  Q4_0,
}

/// Options de chargement (page ou profil du modèle) : toutes facultatives. Les champs absents
/// ne sont pas écrits.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LoadOptions {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub n_ctx: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub n_gpu_layers: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub n_threads: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub n_batch: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub flash_attn: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub cache_type_k: Option<CacheType>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub cache_type_v: Option<CacheType>,
}

// Valeurs par défaut : seule source, utilisée par la résolution (`LoadConfig`, `Sampling`) et
// renvoyée aux pages (`Defaults`).
pub const DEFAULT_N_CTX: u32 = 4096;
pub const DEFAULT_N_BATCH: u32 = 512;
pub const DEFAULT_FLASH_ATTN: bool = false;
pub const DEFAULT_CACHE_TYPE: CacheType = CacheType::F16;
pub const DEFAULT_TEMPERATURE: f32 = 0.8;
pub const DEFAULT_TOP_P: f32 = 0.95;
pub const DEFAULT_TOP_K: i32 = 40;
pub const DEFAULT_MIN_P: f32 = 0.05;
pub const DEFAULT_REPEAT_PENALTY: f32 = 1.1;
pub const DEFAULT_MAX_TOKENS: u32 = 2048;

/// Couches sur GPU par défaut : automatique (None) en build CUDA, aucune sinon.
pub fn default_gpu_layers() -> Option<u32> {
  if CUDA_BUILD { None } else { Some(0) }
}

/// Options de chargement résolues (défauts appliqués). Deux configurations égales = pas de
/// rechargement. `n_gpu_layers` reste la valeur DEMANDÉE (None = auto) : la valeur résolue
/// dépend de la VRAM libre et ne doit pas provoquer de rechargement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadConfig {
  pub n_ctx: u32,
  pub n_gpu_layers: Option<u32>,
  pub n_threads: u32,
  pub n_batch: u32,
  pub flash_attn: bool,
  pub cache_type_k: CacheType,
  pub cache_type_v: CacheType,
}

/// Cœurs physiques approximés : moitié des threads logiques, au moins 1.
pub fn default_threads() -> u32 {
  let logical = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
  u32::try_from(logical / 2).unwrap_or(1).max(1)
}

impl LoadConfig {
  pub fn from_options(o: &LoadOptions) -> Self {
    LoadConfig {
      // 0 = taille d'entraînement du modèle (comportement llama.cpp)
      n_ctx: o.n_ctx.unwrap_or(DEFAULT_N_CTX),
      n_gpu_layers: o.n_gpu_layers.or_else(default_gpu_layers),
      n_threads: o.n_threads.filter(|&n| n > 0).unwrap_or_else(default_threads).min(256),
      n_batch: o.n_batch.filter(|&n| n > 0).unwrap_or(DEFAULT_N_BATCH).clamp(32, 8192),
      flash_attn: o.flash_attn.unwrap_or(DEFAULT_FLASH_ATTN),
      cache_type_k: o.cache_type_k.unwrap_or(DEFAULT_CACHE_TYPE),
      cache_type_v: o.cache_type_v.unwrap_or(DEFAULT_CACHE_TYPE),
    }
  }

  /// Flash Attention effective : un cache V quantifié l'exige, on l'active alors d'office.
  pub fn flash(&self) -> bool {
    self.flash_attn || self.cache_type_v != CacheType::F16
  }

  /// Taille de micro-lot (n_ubatch) passée à llama.cpp.
  pub fn n_ubatch(&self) -> u32 {
    self.n_batch.min(512)
  }
}

impl Default for LoadConfig {
  fn default() -> Self {
    Self::from_options(&LoadOptions::default())
  }
}

/// Paramètres de génération (page ou profil du modèle) : tous facultatifs. Les champs absents
/// ne sont pas écrits.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GenParams {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub temperature: Option<f32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub top_p: Option<f32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub top_k: Option<i32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub min_p: Option<f32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub repeat_penalty: Option<f32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub max_tokens: Option<u32>,
  /// Absent ou négatif : graine aléatoire.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub seed: Option<i64>,
  /// Prompt système du modèle (profil), placé avant celui de la conversation.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub system_prompt: Option<String>,
  /// Requête seulement : false = ignorer le profil du modèle. Jamais enregistré.
  #[serde(skip_serializing)]
  pub use_profile: Option<bool>,
}

impl GenParams {
  /// Complète les champs absents par ceux de `fallback` (le profil).
  pub fn or(self, fallback: &GenParams) -> GenParams {
    GenParams {
      temperature: self.temperature.or(fallback.temperature),
      top_p: self.top_p.or(fallback.top_p),
      top_k: self.top_k.or(fallback.top_k),
      min_p: self.min_p.or(fallback.min_p),
      repeat_penalty: self.repeat_penalty.or(fallback.repeat_penalty),
      max_tokens: self.max_tokens.or(fallback.max_tokens),
      seed: self.seed.or(fallback.seed),
      system_prompt: self.system_prompt.or_else(|| fallback.system_prompt.clone()),
      use_profile: self.use_profile,
    }
  }
}

/// Paramètres de génération résolus et bornés.
#[derive(Debug, Clone, PartialEq)]
pub struct Sampling {
  pub temperature: f32,
  pub top_p: f32,
  pub top_k: i32,
  pub min_p: f32,
  pub repeat_penalty: f32,
  pub max_tokens: u32,
  pub seed: u32,
}

/// Graine "aléatoire" de llama.cpp (LLAMA_DEFAULT_SEED) : tirée au hasard par le sampler dist.
pub const RANDOM_SEED: u32 = u32::MAX;

fn finite(v: Option<f32>) -> Option<f32> {
  v.filter(|x| x.is_finite())
}

impl Sampling {
  pub fn from_params(p: &GenParams) -> Self {
    Sampling {
      temperature: finite(p.temperature).unwrap_or(DEFAULT_TEMPERATURE).clamp(0.0, 10.0),
      top_p: finite(p.top_p).unwrap_or(DEFAULT_TOP_P).clamp(0.0, 1.0),
      // 0 ou négatif : top_k désactivé (comportement llama.cpp)
      top_k: p.top_k.unwrap_or(DEFAULT_TOP_K),
      min_p: finite(p.min_p).unwrap_or(DEFAULT_MIN_P).clamp(0.0, 1.0),
      repeat_penalty: finite(p.repeat_penalty).filter(|&r| r > 0.0).unwrap_or(DEFAULT_REPEAT_PENALTY),
      max_tokens: p.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS).max(1),
      seed: match p.seed {
        Some(s) if s >= 0 => (s & 0xFFFF_FFFF) as u32,
        _ => RANDOM_SEED,
      },
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Profils par modèle
// ---------------------------------------------------------------------------------------------

/// Réglages enregistrés pour un modèle.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelProfile {
  pub load: LoadOptions,
  #[serde(rename = "gen")]
  pub generation: GenParams,
}

/// Valeurs par défaut des options de chargement (toutes présentes, `nGpuLayers` null = auto).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadDefaults {
  pub n_ctx: u32,
  pub n_gpu_layers: Option<u32>,
  pub n_threads: u32,
  pub n_batch: u32,
  pub flash_attn: bool,
  pub cache_type_k: CacheType,
  pub cache_type_v: CacheType,
}

/// Valeurs par défaut des paramètres de génération (`seed` null = aléatoire).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenDefaults {
  pub temperature: f32,
  pub top_p: f32,
  pub top_k: i32,
  pub min_p: f32,
  pub repeat_penalty: f32,
  pub max_tokens: u32,
  pub seed: Option<i64>,
  pub system_prompt: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Defaults {
  pub load: LoadDefaults,
  #[serde(rename = "gen")]
  pub generation: GenDefaults,
}

impl Defaults {
  pub fn current() -> Self {
    Defaults {
      load: LoadDefaults {
        n_ctx: DEFAULT_N_CTX,
        n_gpu_layers: default_gpu_layers(),
        n_threads: default_threads(),
        n_batch: DEFAULT_N_BATCH,
        flash_attn: DEFAULT_FLASH_ATTN,
        cache_type_k: DEFAULT_CACHE_TYPE,
        cache_type_v: DEFAULT_CACHE_TYPE,
      },
      generation: GenDefaults {
        temperature: DEFAULT_TEMPERATURE,
        top_p: DEFAULT_TOP_P,
        top_k: DEFAULT_TOP_K,
        min_p: DEFAULT_MIN_P,
        repeat_penalty: DEFAULT_REPEAT_PENALTY,
        max_tokens: DEFAULT_MAX_TOKENS,
        seed: None,
        system_prompt: String::new(),
      },
    }
  }
}

/// Réponse de `engine_get_profile`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
  pub model_id: String,
  /// Profil enregistré (vide si aucun).
  pub profile: ModelProfile,
  pub defaults: Defaults,
  pub meta: Option<ArchMeta>,
  /// Taille du modèle (toutes ses parties).
  pub size_bytes: u64,
  /// Ce modèle est actuellement chargé.
  pub loaded: bool,
  /// Couches effectivement placées sur le GPU, si chargé.
  pub loaded_gpu_layers: Option<u32>,
  pub gpu_build: bool,
}

/// Réponse de `engine_set_profile` et `engine_reset_profile`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
  /// Les options de chargement résolues ont changé : un rechargement est utile.
  pub load_changed: bool,
  /// Ce modèle est actuellement chargé.
  pub loaded: bool,
}

/// Entrée de `engine_estimate` : un modèle installé (`modelId`) ou des métadonnées fournies
/// (`meta` + `sizeBytes`, ex. fichier distant).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EstimateInput {
  pub model_id: Option<String>,
  pub size_bytes: Option<u64>,
  pub meta: Option<ArchMeta>,
  pub options: Option<LoadOptions>,
  pub vram_bytes: Option<u64>,
  pub ram_bytes: Option<u64>,
}
