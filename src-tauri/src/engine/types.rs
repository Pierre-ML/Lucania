//! Types échangés avec les pages (JSON en camelCase) et réglages résolus du moteur.

use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessage {
  pub role: String,
  pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum CacheType {
  #[serde(rename = "f16")]
  F16,
  #[serde(rename = "q8_0")]
  Q8_0,
  #[serde(rename = "q4_0")]
  Q4_0,
}

/// Options de chargement envoyées par la page : toutes facultatives.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadOptions {
  pub n_ctx: Option<u32>,
  pub n_gpu_layers: Option<u32>,
  pub n_threads: Option<u32>,
  pub n_batch: Option<u32>,
  pub flash_attn: Option<bool>,
  pub cache_type_k: Option<CacheType>,
  pub cache_type_v: Option<CacheType>,
}

/// Options de chargement résolues (défauts appliqués). Deux configurations égales = pas de
/// rechargement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadConfig {
  pub n_ctx: u32,
  pub n_gpu_layers: u32,
  pub n_threads: u32,
  pub n_batch: u32,
  pub flash_attn: bool,
  pub cache_type_k: CacheType,
  pub cache_type_v: CacheType,
}

/// Cœurs physiques approximés : moitié des threads logiques, au moins 1.
fn default_threads() -> u32 {
  let logical = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
  u32::try_from(logical / 2).unwrap_or(1).max(1)
}

impl LoadConfig {
  pub fn from_options(o: &LoadOptions) -> Self {
    let gpu_default = if CUDA_BUILD { 999 } else { 0 };
    LoadConfig {
      // 0 = taille d'entraînement du modèle (comportement llama.cpp)
      n_ctx: o.n_ctx.unwrap_or(4096),
      n_gpu_layers: o.n_gpu_layers.unwrap_or(gpu_default),
      n_threads: o.n_threads.filter(|&n| n > 0).unwrap_or_else(default_threads).min(256),
      n_batch: o.n_batch.filter(|&n| n > 0).unwrap_or(512).clamp(32, 8192),
      flash_attn: o.flash_attn.unwrap_or(false),
      cache_type_k: o.cache_type_k.unwrap_or(CacheType::F16),
      cache_type_v: o.cache_type_v.unwrap_or(CacheType::F16),
    }
  }
}

impl Default for LoadConfig {
  fn default() -> Self {
    Self::from_options(&LoadOptions::default())
  }
}

/// Paramètres de génération envoyés par la page : tous facultatifs.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenParams {
  pub temperature: Option<f32>,
  pub top_p: Option<f32>,
  pub top_k: Option<i32>,
  pub min_p: Option<f32>,
  pub repeat_penalty: Option<f32>,
  pub max_tokens: Option<u32>,
  /// Absent ou négatif : graine aléatoire.
  pub seed: Option<i64>,
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
      temperature: finite(p.temperature).unwrap_or(0.8).clamp(0.0, 10.0),
      top_p: finite(p.top_p).unwrap_or(0.95).clamp(0.0, 1.0),
      // 0 ou négatif : top_k désactivé (comportement llama.cpp)
      top_k: p.top_k.unwrap_or(40),
      min_p: finite(p.min_p).unwrap_or(0.05).clamp(0.0, 1.0),
      repeat_penalty: finite(p.repeat_penalty).filter(|&r| r > 0.0).unwrap_or(1.1),
      max_tokens: p.max_tokens.unwrap_or(2048).max(1),
      seed: match p.seed {
        Some(s) if s >= 0 => (s & 0xFFFF_FFFF) as u32,
        _ => RANDOM_SEED,
      },
    }
  }
}
