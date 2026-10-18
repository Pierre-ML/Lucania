//! Estimation mémoire d'un modèle (poids, cache KV, tampons de calcul) et choix automatique du
//! nombre de couches sur GPU. Fonctions pures : aucune lecture de fichier ni de périphérique.
//!
//! Approximation volontairement prudente : les poids sont répartis uniformément entre les
//! couches, le cache KV suit les dimensions du GGUF, les tampons de calcul sont majorés.

use serde::Serialize;

use super::gguf::ArchMeta;
use super::types::{CacheType, LoadConfig};

const MIB: f64 = 1024.0 * 1024.0;
/// Part de la VRAM utilisable (marge pour le pilote et l'affichage).
const VRAM_USABLE: f64 = 0.95;
/// Part de la RAM utilisable par le modèle.
const RAM_USABLE: f64 = 0.7;
/// Surcoût fixe des tampons de calcul GPU.
const COMPUTE_BASE: f64 = 256.0 * MIB;
/// Surcoût fixe côté RAM (processus, tampons CPU).
const RAM_OVERHEAD: f64 = 512.0 * MIB;
/// Contexte retenu si nCtx = 0 et que le GGUF ne donne pas sa taille d'entraînement.
const FALLBACK_CTX: u64 = 4096;

/// Résultat de `engine_estimate` (octets entiers).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VramEstimate {
  /// Métadonnées suffisantes pour estimer.
  pub known: bool,
  pub block_count: Option<u64>,
  /// Couches sur GPU retenues (demandées bornées à blockCount, ou automatiques).
  pub gpu_layers: u64,
  pub auto_gpu_layers: u64,
  /// Contexte effectif.
  pub n_ctx: u64,
  /// Contexte d'entraînement du modèle.
  pub max_context: Option<u64>,
  pub weights_gpu_bytes: u64,
  pub weights_cpu_bytes: u64,
  pub kv_gpu_bytes: u64,
  pub kv_cpu_bytes: u64,
  pub compute_bytes: u64,
  pub total_gpu_bytes: u64,
  pub vram_bytes: u64,
  pub ram_bytes: u64,
  pub fits: bool,
  /// "gpu" | "mixed" | "cpu" | "too-big"
  pub fit: &'static str,
}

/// Octets par élément du cache KV.
fn cache_bytes(t: CacheType) -> f64 {
  match t {
    CacheType::F16 => 2.0,
    CacheType::Q8_0 => 34.0 / 32.0,
    CacheType::Q4_0 => 18.0 / 32.0,
  }
}

/// Contexte effectif : nCtx, ou (0) la taille d'entraînement, sinon 4096.
pub fn effective_ctx(config: &LoadConfig, meta: &ArchMeta) -> u64 {
  if config.n_ctx > 0 {
    u64::from(config.n_ctx)
  } else {
    meta.context_length.filter(|&c| c > 0).unwrap_or(FALLBACK_CTX)
  }
}

/// Modèle de coût résolu (tout en f64).
struct Model {
  layers: u64,
  size: f64,
  /// Cache KV d'une couche.
  kv_layer: f64,
  /// Tampons de calcul GPU (dès qu'au moins une couche est sur GPU).
  compute: f64,
}

impl Model {
  fn new(size_bytes: u64, meta: &ArchMeta, config: &LoadConfig) -> Option<Model> {
    let layers = meta.block_count.filter(|&l| l > 0)?;
    let embd = meta.embedding_length.filter(|&e| e > 0)? as f64;
    let n_head_kv = meta.n_head_kv().filter(|&n| n > 0)? as f64;
    let hk = meta.head_dim_k().filter(|&d| d > 0)? as f64;
    let hv = meta.head_dim_v().filter(|&d| d > 0)? as f64;
    let heads = meta.head_count.filter(|&h| h > 0).map(|h| h as f64).unwrap_or(n_head_kv);
    let n_ctx = effective_ctx(config, meta) as f64;
    let ubatch = f64::from(config.n_ubatch());
    let kv_layer = n_ctx * n_head_kv * (hk * cache_bytes(config.cache_type_k) + hv * cache_bytes(config.cache_type_v));
    let attention = if config.flash() { 0.0 } else { n_ctx * ubatch * heads * 4.0 };
    let compute = COMPUTE_BASE + ubatch * embd * 4.0 * 8.0 + attention;
    Some(Model { layers, size: size_bytes as f64, kv_layer, compute })
  }

  fn weights_gpu(&self, g: u64) -> f64 {
    self.size * g as f64 / self.layers as f64
  }

  fn kv_gpu(&self, g: u64) -> f64 {
    self.kv_layer * g as f64
  }

  fn compute_gpu(&self, g: u64) -> f64 {
    if g > 0 { self.compute } else { 0.0 }
  }

  fn total_gpu(&self, g: u64) -> f64 {
    self.weights_gpu(g) + self.kv_gpu(g) + self.compute_gpu(g)
  }

  fn kv_total(&self) -> f64 {
    self.kv_gpu(self.layers)
  }

  /// Plus grand nombre de couches tenant dans `vram` (0 sans VRAM).
  fn auto_layers(&self, vram: u64) -> u64 {
    if vram == 0 {
      return 0;
    }
    let budget = vram as f64 * VRAM_USABLE;
    (0..=self.layers).rev().find(|&g| self.total_gpu(g) <= budget).unwrap_or(0)
  }
}

fn bytes(v: f64) -> u64 {
  if v.is_finite() && v > 0.0 { v.round() as u64 } else { 0 }
}

/// Couches à placer sur GPU pour tenir dans `vram` octets ; None si les métadonnées manquent.
pub fn auto_gpu_layers(size_bytes: u64, meta: &ArchMeta, config: &LoadConfig, vram: u64) -> Option<u64> {
  Model::new(size_bytes, meta, config).map(|m| m.auto_layers(vram))
}

/// Estimation complète pour la configuration demandée.
pub fn estimate(size_bytes: u64, meta: &ArchMeta, config: &LoadConfig, vram: u64, ram: u64) -> VramEstimate {
  let mut out = VramEstimate {
    block_count: meta.block_count,
    n_ctx: effective_ctx(config, meta),
    max_context: meta.context_length,
    vram_bytes: vram,
    ram_bytes: ram,
    fit: "too-big",
    ..VramEstimate::default()
  };
  let Some(m) = Model::new(size_bytes, meta, config) else {
    return out;
  };
  let auto = m.auto_layers(vram);
  let g = match config.n_gpu_layers {
    Some(n) => u64::from(n).min(m.layers),
    None => auto,
  };
  let total = m.total_gpu(g);
  let budget = vram as f64 * VRAM_USABLE;
  let ram_budget = ram as f64 * RAM_USABLE;
  let fits = if vram == 0 { g == 0 } else { total <= budget };
  let cpu_at_auto = (m.size - m.weights_gpu(auto)) + (m.kv_total() - m.kv_gpu(auto));
  let fit = if vram > 0 && m.total_gpu(m.layers) <= budget {
    "gpu"
  } else if vram > 0 && cpu_at_auto + RAM_OVERHEAD <= ram_budget {
    "mixed"
  } else if vram == 0 && m.size + m.kv_total() + RAM_OVERHEAD <= ram_budget {
    "cpu"
  } else {
    "too-big"
  };
  out.known = true;
  out.gpu_layers = g;
  out.auto_gpu_layers = auto;
  out.weights_gpu_bytes = bytes(m.weights_gpu(g));
  out.weights_cpu_bytes = size_bytes.saturating_sub(out.weights_gpu_bytes);
  out.kv_gpu_bytes = bytes(m.kv_gpu(g));
  out.kv_cpu_bytes = bytes(m.kv_total()).saturating_sub(out.kv_gpu_bytes);
  out.compute_bytes = bytes(m.compute_gpu(g));
  out.total_gpu_bytes = out.weights_gpu_bytes + out.kv_gpu_bytes + out.compute_bytes;
  out.fits = fits;
  out.fit = fit;
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  const GIB: u64 = 1 << 30;

  fn llama_8b() -> ArchMeta {
    ArchMeta {
      block_count: Some(32),
      head_count: Some(32),
      head_count_kv: Some(8),
      key_length: None,
      value_length: None,
      embedding_length: Some(4096),
      context_length: Some(131072),
    }
  }

  fn big_27b() -> ArchMeta {
    ArchMeta {
      block_count: Some(62),
      head_count: Some(32),
      head_count_kv: Some(16),
      key_length: Some(128),
      value_length: Some(128),
      embedding_length: Some(5376),
      context_length: Some(131072),
    }
  }

  fn cfg(n_ctx: u32, gpu: Option<u32>) -> LoadConfig {
    LoadConfig { n_ctx, n_gpu_layers: gpu, ..LoadConfig::default() }
  }

  #[test]
  fn modele_8b_tient_sur_8_gio() {
    let e = estimate(4_900_000_000, &llama_8b(), &cfg(4096, None), 8 * GIB, 32 * GIB);
    assert!(e.known);
    assert_eq!((e.gpu_layers, e.auto_gpu_layers, e.n_ctx), (32, 32, 4096));
    assert!(e.fits);
    assert_eq!(e.fit, "gpu");
    assert_eq!((e.weights_cpu_bytes, e.kv_cpu_bytes), (0, 0));
    // KV f16 : 32 couches × 4096 × 8 têtes × (128 + 128) × 2 octets = 512 Mio.
    assert_eq!(e.kv_gpu_bytes, 512 << 20);
    assert_eq!(e.total_gpu_bytes, e.weights_gpu_bytes + e.kv_gpu_bytes + e.compute_bytes);
  }

  #[test]
  fn modele_27b_partiellement_sur_gpu() {
    let e = estimate(16_000_000_000, &big_27b(), &cfg(4096, None), 8 * GIB, 32 * GIB);
    assert!(e.auto_gpu_layers > 0 && e.auto_gpu_layers < 62, "{e:?}");
    assert_eq!(e.gpu_layers, e.auto_gpu_layers);
    assert!(e.fits);
    assert_eq!(e.fit, "mixed");
    assert!(e.weights_cpu_bytes > 0 && e.kv_cpu_bytes > 0);
    // Demande explicite au-delà de la VRAM : ne tient pas, bornée à blockCount.
    let e = estimate(16_000_000_000, &big_27b(), &cfg(4096, Some(999)), 8 * GIB, 32 * GIB);
    assert_eq!(e.gpu_layers, 62);
    assert!(!e.fits);
    // Peu de RAM : trop gros.
    let e = estimate(16_000_000_000, &big_27b(), &cfg(4096, None), 8 * GIB, 8 * GIB);
    assert_eq!(e.fit, "too-big");
    assert_eq!(auto_gpu_layers(16_000_000_000, &big_27b(), &cfg(4096, None), 8 * GIB), Some(e.auto_gpu_layers));
  }

  #[test]
  fn cache_quantifie_reduit_le_kv() {
    let f16 = estimate(4_900_000_000, &llama_8b(), &cfg(8192, Some(32)), 8 * GIB, 0);
    let q8 = LoadConfig { cache_type_k: CacheType::Q8_0, cache_type_v: CacheType::Q8_0, ..cfg(8192, Some(32)) };
    let q8 = estimate(4_900_000_000, &llama_8b(), &q8, 8 * GIB, 0);
    assert!(q8.kv_gpu_bytes < f16.kv_gpu_bytes * 6 / 10, "{} / {}", q8.kv_gpu_bytes, f16.kv_gpu_bytes);
    // Cache V quantifié : Flash Attention forcée, pas de tampon d'attention n_ctx × n_ubatch.
    assert!(q8.compute_bytes < f16.compute_bytes);
  }

  #[test]
  fn contexte_zero_et_sans_gpu() {
    let e = estimate(4_900_000_000, &llama_8b(), &cfg(0, Some(0)), 0, 64 * GIB);
    assert_eq!((e.n_ctx, e.max_context), (131072, Some(131072)));
    assert_eq!((e.gpu_layers, e.auto_gpu_layers, e.compute_bytes, e.total_gpu_bytes), (0, 0, 0, 0));
    assert!(e.fits);
    assert_eq!(e.fit, "cpu");
    // Sans context_length : 4096.
    let meta = ArchMeta { context_length: None, ..llama_8b() };
    assert_eq!(estimate(1, &meta, &cfg(0, Some(0)), 0, 0).n_ctx, 4096);
    // Sans VRAM, couches demandées sur GPU : ne tient pas.
    assert!(!estimate(4_900_000_000, &llama_8b(), &cfg(4096, Some(10)), 0, 64 * GIB).fits);
  }

  #[test]
  fn metadonnees_manquantes() {
    let meta = ArchMeta { embedding_length: None, ..llama_8b() };
    let e = estimate(4_900_000_000, &meta, &cfg(4096, None), 8 * GIB, 32 * GIB);
    assert!(!e.known && !e.fits);
    assert_eq!((e.gpu_layers, e.total_gpu_bytes, e.block_count), (0, 0, Some(32)));
    assert_eq!(auto_gpu_layers(4_900_000_000, &meta, &cfg(4096, None), 8 * GIB), None);
    assert_eq!(auto_gpu_layers(1, &ArchMeta::default(), &cfg(4096, None), 8 * GIB), None);
  }
}
