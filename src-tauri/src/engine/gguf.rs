//! Lecture de l'en-tête GGUF (métadonnées et infos de tenseurs, jamais les poids) pour refuser,
//! avant llama.cpp, les fichiers qui ne sont pas des modèles de langage autonomes.
//!
//! Raison : llama.cpp accepte certains fichiers annexes (ex. tête MTP « mtp-*.gguf » : seule la
//! dernière couche et les tenseurs `nextn.*`) puis lit des tenseurs absents à la création du
//! contexte : violation d'accès, l'app se ferme sans message. Le parseur est écrit en Rust pur :
//! un fichier malformé donne une erreur, jamais un arrêt du processus.
//!
//! Deux sources : un fichier local (`check_model`, avant chargement) ou le début d'un fichier
//! distant lu par requêtes Range (`parse_header`, avant téléchargement : `hf::check`). Les mêmes
//! règles (`check_kind`, `check_tensors`) servent aux deux.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const MAGIC: &[u8; 4] = b"GGUF";
/// Garde-fous contre un en-tête corrompu.
const MAX_KV: u64 = 1 << 20;
const MAX_TENSORS: u64 = 1 << 20;
const MAX_KEY_LEN: u64 = 1 << 16;
const MAX_DIMS: u32 = 8;
/// Les chaînes plus longues (modèle de chat, etc.) sont sautées : inutiles ici.
const MAX_KEPT_STR: u64 = 4096;

#[derive(Debug, Clone, PartialEq)]
enum Value {
  UInt(u64),
  Int(i64),
  /// Flottant ou booléen : valeur non utilisée ici.
  Other,
  Str(String),
  /// Chaîne trop longue, non conservée.
  LongStr,
  Array,
}

/// En-tête lu : métadonnées, noms des tenseurs et nombre total de paramètres (somme des
/// éléments des tenseurs).
#[derive(Debug, Default)]
pub(crate) struct Header {
  kv: HashMap<String, Value>,
  tensors: Vec<String>,
  n_params: u64,
}

impl Header {
  fn str(&self, key: &str) -> Option<&str> {
    match self.kv.get(key) {
      Some(Value::Str(s)) => Some(s),
      _ => None,
    }
  }

  fn uint(&self, key: &str) -> Option<u64> {
    match self.kv.get(key) {
      Some(Value::UInt(v)) => Some(*v),
      Some(Value::Int(v)) => u64::try_from(*v).ok(),
      _ => None,
    }
  }

  /// Nombre de parties d'un modèle découpé (1 s'il ne l'est pas).
  pub(crate) fn split_count(&self) -> u64 {
    self.uint("split.count").unwrap_or(1).max(1)
  }
}

/// Échec de lecture d'un en-tête.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum HeaderError {
  /// Tampon partiel épuisé avant la fin de l'en-tête : il faut lire la suite du fichier.
  Incomplete,
  /// Fichier invalide (message court, sans nom de fichier).
  Invalid(String),
}

impl From<&str> for HeaderError {
  fn from(e: &str) -> Self {
    HeaderError::Invalid(e.to_string())
  }
}

impl From<String> for HeaderError {
  fn from(e: String) -> Self {
    HeaderError::Invalid(e)
  }
}

fn truncated() -> HeaderError {
  "en-tête tronqué".into()
}

enum Source<'a> {
  File(BufReader<File>),
  /// Début du fichier (tout ou partie).
  Mem(&'a [u8]),
}

/// Lecteur borné par la taille du fichier : un saut ou une lecture au-delà échoue. Sur un tampon
/// partiel, une lecture au-delà du tampon (mais dans le fichier) donne `Incomplete`.
struct Reader<'a> {
  src: Source<'a>,
  pos: u64,
  len: u64,
}

impl Reader<'_> {
  /// Position de fin d'une lecture de `n` octets, après contrôle des bornes.
  fn reserve(&self, n: u64) -> Result<u64, HeaderError> {
    let end = self.pos.checked_add(n).filter(|&e| e <= self.len).ok_or_else(truncated)?;
    if let Source::Mem(b) = &self.src {
      if end > b.len() as u64 {
        return Err(HeaderError::Incomplete);
      }
    }
    Ok(end)
  }

  fn bytes(&mut self, out: &mut [u8]) -> Result<(), HeaderError> {
    let end = self.reserve(out.len() as u64)?;
    match &mut self.src {
      Source::File(f) => f.read_exact(out).map_err(|_| truncated())?,
      // Bornes vérifiées par `reserve`.
      Source::Mem(b) => out.copy_from_slice(&b[self.pos as usize..end as usize]),
    }
    self.pos = end;
    Ok(())
  }

  fn read<const N: usize>(&mut self) -> Result<[u8; N], HeaderError> {
    let mut b = [0u8; N];
    self.bytes(&mut b)?;
    Ok(b)
  }

  fn u32(&mut self) -> Result<u32, HeaderError> {
    Ok(u32::from_le_bytes(self.read()?))
  }

  fn u64(&mut self) -> Result<u64, HeaderError> {
    Ok(u64::from_le_bytes(self.read()?))
  }

  fn skip(&mut self, n: u64) -> Result<(), HeaderError> {
    let end = self.reserve(n)?;
    if let Source::File(f) = &mut self.src {
      let step = i64::try_from(n).map_err(|_| truncated())?;
      f.seek_relative(step).map_err(|e| format!("lecture impossible : {e}"))?;
    }
    self.pos = end;
    Ok(())
  }

  /// Chaîne GGUF (u64 + octets) ; `None` si plus longue que `max` (alors sautée).
  fn string(&mut self, max: u64) -> Result<Option<String>, HeaderError> {
    let n = self.u64()?;
    if n > max {
      self.skip(n)?;
      return Ok(None);
    }
    self.reserve(n)?;
    let mut b = vec![0u8; n as usize];
    self.bytes(&mut b)?;
    Ok(Some(String::from_utf8_lossy(&b).into_owned()))
  }

  /// Taille fixe d'un type scalaire GGUF (hors chaîne et tableau).
  fn scalar_size(t: u32) -> Option<u64> {
    match t {
      0 | 1 | 7 => Some(1),
      2 | 3 => Some(2),
      4..=6 => Some(4),
      10..=12 => Some(8),
      _ => None,
    }
  }

  fn value(&mut self, t: u32) -> Result<Value, HeaderError> {
    Ok(match t {
      0 => Value::UInt(self.read::<1>()?[0] as u64),
      1 => Value::Int(self.read::<1>()?[0] as i8 as i64),
      2 => Value::UInt(u16::from_le_bytes(self.read()?) as u64),
      3 => Value::Int(i16::from_le_bytes(self.read()?) as i64),
      4 => Value::UInt(self.u32()? as u64),
      5 => Value::Int(i32::from_le_bytes(self.read()?) as i64),
      6 => {
        self.skip(4)?;
        Value::Other
      }
      7 => {
        self.skip(1)?;
        Value::Other
      }
      8 => self.string(MAX_KEPT_STR)?.map(Value::Str).unwrap_or(Value::LongStr),
      9 => {
        let et = self.u32()?;
        let n = self.u64()?;
        if et == 8 {
          for _ in 0..n {
            let len = self.u64()?;
            self.skip(len)?;
          }
        } else {
          let size = Self::scalar_size(et).ok_or_else(|| format!("type de tableau inconnu ({et})"))?;
          self.skip(n.checked_mul(size).ok_or_else(truncated)?)?;
        }
        Value::Array
      }
      10 => Value::UInt(self.u64()?),
      11 => Value::Int(i64::from_le_bytes(self.read()?)),
      12 => {
        self.skip(8)?;
        Value::Other
      }
      _ => return Err(format!("type de valeur inconnu ({t})").into()),
    })
  }

  /// Métadonnées et infos de tenseurs (versions 2 et 3).
  fn header(&mut self) -> Result<Header, HeaderError> {
    if &self.read::<4>()? != MAGIC {
      return Err("signature GGUF absente".into());
    }
    let version = self.u32()?;
    if !(2..=3).contains(&version) {
      return Err(format!("version GGUF {version} non prise en charge").into());
    }
    let n_tensors = self.u64()?;
    let n_kv = self.u64()?;
    if n_tensors > MAX_TENSORS || n_kv > MAX_KV {
      return Err("en-tête incohérent".into());
    }
    let mut h = Header::default();
    for _ in 0..n_kv {
      let key = self.string(MAX_KEY_LEN)?.ok_or("clé trop longue")?;
      let t = self.u32()?;
      let v = self.value(t)?;
      h.kv.insert(key, v);
    }
    for _ in 0..n_tensors {
      let name = self.string(MAX_KEY_LEN)?.ok_or("nom de tenseur trop long")?;
      let n_dims = self.u32()?;
      if n_dims > MAX_DIMS {
        return Err("tenseur incohérent".into());
      }
      let mut elements: u64 = 1;
      for _ in 0..n_dims {
        elements = elements.saturating_mul(self.u64()?);
      }
      // Type et décalage des données : inutiles ici.
      self.skip(4 + 8)?;
      h.n_params = h.n_params.saturating_add(elements);
      h.tensors.push(name);
    }
    Ok(h)
  }
}

/// Lit l'en-tête d'un fichier GGUF local.
fn read_header(path: &Path) -> Result<Header, String> {
  let file = File::open(path).map_err(|e| format!("ouverture impossible : {e}"))?;
  let len = file.metadata().map_err(|e| format!("lecture impossible : {e}"))?.len();
  let mut r = Reader { src: Source::File(BufReader::with_capacity(1 << 16, file)), pos: 0, len };
  r.header().map_err(|e| match e {
    HeaderError::Invalid(e) => e,
    // Impossible sur un fichier : toute lecture est bornée par sa taille.
    HeaderError::Incomplete => "en-tête tronqué".into(),
  })
}

/// Lit l'en-tête depuis le début d'un fichier (`buf`, éventuellement partiel) dont la taille
/// totale est `total_len`. `Incomplete` : il faut un tampon plus long.
pub(crate) fn parse_header(buf: &[u8], total_len: u64) -> Result<Header, HeaderError> {
  let mut r = Reader { src: Source::Mem(buf), pos: 0, len: total_len.max(buf.len() as u64) };
  r.header()
}

/// Message d'un fichier illisible (`name` : nom du fichier sans dossier).
pub(crate) fn invalid_message(name: &str, e: &str) -> String {
  format!("« {name} » n'est pas un fichier GGUF valide ({e}).")
}

/// Message d'une partie absente d'un modèle découpé.
pub(crate) fn missing_part_message(name: &str, part: &str) -> String {
  format!("Partie manquante du modèle « {name} » : « {part} ».")
}

/// Message d'un nom de modèle découpé non reconnu.
pub(crate) fn split_name_message(name: &str) -> String {
  format!("« {name} » : nom de modèle découpé non reconnu.")
}

/// Parties d'un modèle découpé (`xxx-00001-of-0000N.gguf`) : toutes, dans l'ordre. `None` si le
/// nom ne suit pas le motif de llama.cpp.
fn split_paths(first: &Path, count: u64) -> Option<Vec<PathBuf>> {
  let name = first.file_name()?.to_str()?;
  let stem = name.strip_suffix(".gguf").or_else(|| name.strip_suffix(".GGUF"))?;
  let suffix = format!("-00001-of-{count:05}");
  let prefix = stem.strip_suffix(&suffix)?;
  let dir = first.parent()?;
  Some((1..=count).map(|i| dir.join(format!("{prefix}-{i:05}-of-{count:05}.gguf"))).collect())
}

/// Indice de couche d'un tenseur `blk.<n>.…`.
fn block_index(tensor: &str) -> Option<u64> {
  tensor.strip_prefix("blk.")?.split('.').next()?.parse().ok()
}

fn display(path: &Path) -> String {
  path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn annex(name: &str, what: &str) -> String {
  format!("« {name} » n'est pas un modèle de chat autonome (fichier annexe : {what}).")
}

/// Première série de règles, sur l'en-tête de la première partie seule : type de fichier et
/// architecture. Renvoie l'architecture.
pub(crate) fn check_kind(name: &str, h: &Header) -> Result<String, String> {
  if let Some(kind) = h.str("general.type") {
    match kind {
      "model" => {}
      "mmproj" => return Err(annex(name, "projecteur de vision")),
      "adapter" => return Err(annex(name, "adaptateur LoRA")),
      "imatrix" => return Err(annex(name, "matrice d'importance de quantification")),
      other => return Err(annex(name, &format!("type « {other} »"))),
    }
  }
  let Some(arch) = h.str("general.architecture").map(str::to_string) else {
    return Err(format!("« {name} » n'indique pas d'architecture : ce n'est pas un modèle de langage."));
  };
  if arch == "clip" {
    return Err(annex(name, "projecteur de vision"));
  }
  Ok(arch)
}

/// Seconde série de règles, sur les tenseurs de toutes les parties : vocabulaire et couches du
/// tronc. `first` porte les métadonnées, `others` : en-têtes des parties suivantes.
pub(crate) fn check_tensors(name: &str, arch: &str, first: &Header, others: &[Header]) -> Result<(), String> {
  let tensors: HashSet<&str> =
    first.tensors.iter().chain(others.iter().flat_map(|h| h.tensors.iter())).map(String::as_str).collect();

  if !tensors.contains("token_embd.weight") {
    return Err(format!("« {name} » ne contient pas de table de vocabulaire (token_embd) : ce n'est pas un modèle de chat autonome."));
  }

  // Couches du tronc : toutes doivent être présentes. Les têtes MTP (`<arch>.nextn_predict_layers`)
  // sont comptées dans block_count mais facultatives.
  let blocks: HashSet<u64> = tensors.iter().filter_map(|t| block_index(t)).collect();
  let block_count = first.uint(&format!("{arch}.block_count")).unwrap_or(0);
  let nextn = first.uint(&format!("{arch}.nextn_predict_layers")).unwrap_or(0);
  let trunk = block_count.saturating_sub(nextn);
  if !blocks.is_empty() && trunk > 0 {
    let present = blocks.iter().filter(|&&b| b < trunk).count() as u64;
    if present < trunk {
      let mtp = tensors.iter().any(|t| t.contains(".nextn.")) || present == 0;
      if mtp {
        return Err(annex(name, "tête MTP de prédiction multi-jetons, à utiliser avec le modèle complet"));
      }
      return Err(format!("« {name} » est incomplet : {} couche(s) sur {trunk} absentes du fichier.", trunk - present));
    }
  }
  Ok(())
}

/// Caractéristiques lues dans l'en-tête (affichage).
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ModelInfo {
  pub architecture: Option<String>,
  pub block_count: Option<u64>,
  pub context_length: Option<u64>,
  /// Somme des éléments des tenseurs de toutes les parties ; à défaut, `general.size_label`.
  pub param_count: Option<u64>,
}

/// « 27B » -> 27e9, « 0.6B », « 8x7B » -> 56e9, « 235B-A22B » -> 235e9, « 125M ».
fn parse_size_label(label: &str) -> Option<u64> {
  let head = label.trim().split(['-', ' ']).next()?;
  let (mult, size) = match head.split_once(['x', 'X']) {
    Some((n, s)) => (n.parse::<f64>().ok()?, s),
    None => (1.0, head),
  };
  let unit = match size.chars().last()?.to_ascii_uppercase() {
    'K' => 1e3,
    'M' => 1e6,
    'B' => 1e9,
    'T' => 1e12,
    _ => return None,
  };
  let n: f64 = size[..size.len() - 1].parse().ok()?;
  let v = mult * n * unit;
  (v.is_finite() && (1.0..1e16).contains(&v)).then_some(v.round() as u64)
}

pub(crate) fn model_info(first: &Header, others: &[Header]) -> ModelInfo {
  let arch = first.str("general.architecture").map(str::to_string);
  let key = |k: &str| arch.as_deref().and_then(|a| first.uint(&format!("{a}.{k}")));
  let summed = others.iter().fold(first.n_params, |acc, h| acc.saturating_add(h.n_params));
  ModelInfo {
    block_count: key("block_count"),
    context_length: key("context_length"),
    param_count: (summed > 0).then_some(summed).or_else(|| first.str("general.size_label").and_then(parse_size_label)),
    architecture: arch,
  }
}

/// Dimensions de l'architecture utiles à l'estimation mémoire (`engine::estimate`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchMeta {
  pub block_count: Option<u64>,
  pub head_count: Option<u64>,
  /// Absent si le GGUF donne une valeur par couche (tableau).
  pub head_count_kv: Option<u64>,
  pub key_length: Option<u64>,
  pub value_length: Option<u64>,
  pub embedding_length: Option<u64>,
  pub context_length: Option<u64>,
}

impl ArchMeta {
  /// Dimension par défaut d'une tête : embedding_length / head_count.
  fn default_head_dim(&self) -> Option<u64> {
    match (self.embedding_length, self.head_count) {
      (Some(e), Some(h)) if h > 0 => Some(e / h),
      _ => None,
    }
  }

  pub fn head_dim_k(&self) -> Option<u64> {
    self.key_length.or_else(|| self.default_head_dim())
  }

  pub fn head_dim_v(&self) -> Option<u64> {
    self.value_length.or_else(|| self.default_head_dim())
  }

  /// Têtes clé/valeur : head_count_kv, sinon head_count (pas de GQA).
  pub fn n_head_kv(&self) -> Option<u64> {
    self.head_count_kv.or(self.head_count)
  }
}

pub(crate) fn arch_meta(h: &Header) -> ArchMeta {
  let Some(arch) = h.str("general.architecture") else {
    return ArchMeta::default();
  };
  let key = |k: &str| h.uint(&format!("{arch}.{k}"));
  ArchMeta {
    block_count: key("block_count"),
    head_count: key("attention.head_count"),
    head_count_kv: key("attention.head_count_kv"),
    key_length: key("attention.key_length"),
    value_length: key("attention.value_length"),
    embedding_length: key("embedding_length"),
    context_length: key("context_length"),
  }
}

/// Métadonnées d'architecture d'un GGUF local (en-tête de la première partie).
pub(crate) fn read_arch_meta(path: &Path) -> Result<ArchMeta, String> {
  let h = read_header(path).map_err(|e| invalid_message(&display(path), &e))?;
  Ok(arch_meta(&h))
}

/// Vérifie qu'un GGUF est un modèle de langage autonome avant de le confier à llama.cpp.
pub fn check_model(path: &Path) -> Result<(), String> {
  let name = display(path);
  let h = read_header(path).map_err(|e| invalid_message(&name, &e))?;
  let arch = check_kind(&name, &h)?;

  // En-têtes des autres parties d'un modèle découpé (chaque partie a son propre en-tête).
  let mut others = Vec::new();
  let count = h.split_count();
  if count > 1 {
    let parts = split_paths(path, count).ok_or_else(|| split_name_message(&name))?;
    for part in parts.iter().skip(1) {
      if !part.is_file() {
        return Err(missing_part_message(&name, &display(part)));
      }
      others.push(read_header(part).map_err(|e| invalid_message(&display(part), &e))?);
    }
  }
  check_tensors(&name, &arch, &h, &others)
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Fabrique un GGUF v3 minimal (métadonnées et tenseurs, sans données).
  fn gguf(kv: &[(&str, Value)], tensors: &[&str]) -> Vec<u8> {
    let s = |out: &mut Vec<u8>, v: &str| {
      out.extend((v.len() as u64).to_le_bytes());
      out.extend(v.as_bytes());
    };
    let mut out = b"GGUF".to_vec();
    out.extend(3u32.to_le_bytes());
    out.extend((tensors.len() as u64).to_le_bytes());
    out.extend((kv.len() as u64).to_le_bytes());
    for (k, v) in kv {
      s(&mut out, k);
      match v {
        Value::UInt(n) => {
          out.extend(4u32.to_le_bytes());
          out.extend((*n as u32).to_le_bytes());
        }
        Value::Str(t) => {
          out.extend(8u32.to_le_bytes());
          s(&mut out, t);
        }
        Value::Array => {
          // Tableau de chaînes, comme tokenizer.ggml.tokens
          out.extend(9u32.to_le_bytes());
          out.extend(8u32.to_le_bytes());
          out.extend(2u64.to_le_bytes());
          s(&mut out, "a");
          s(&mut out, "bc");
        }
        _ => unreachable!(),
      }
    }
    for t in tensors {
      s(&mut out, t);
      out.extend(1u32.to_le_bytes());
      out.extend(16u64.to_le_bytes());
      out.extend(0u32.to_le_bytes());
      out.extend(0u64.to_le_bytes());
    }
    out
  }

  fn st(v: &str) -> Value {
    Value::Str(v.into())
  }

  struct Dir(PathBuf);
  impl Drop for Dir {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  fn dir(tag: &str) -> Dir {
    let d = std::env::temp_dir().join(format!("lucania-gguf-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    Dir(d)
  }

  fn check(d: &Dir, file: &str, bytes: &[u8]) -> Result<(), String> {
    let p = d.0.join(file);
    std::fs::write(&p, bytes).unwrap();
    check_model(&p)
  }

  fn base(arch: &str, blocks: u64) -> Vec<(&'static str, Value)> {
    vec![
      ("general.architecture", st(arch)),
      ("general.type", st("model")),
      ("tokenizer.ggml.tokens", Value::Array),
      (if arch == "llama" { "llama.block_count" } else { "qwen35.block_count" }, Value::UInt(blocks)),
    ]
  }

  #[test]
  fn modele_autonome_accepte() {
    let d = dir("ok");
    let b = gguf(&base("llama", 2), &["token_embd.weight", "blk.0.attn_norm.weight", "blk.1.attn_norm.weight", "output.weight"]);
    assert_eq!(check(&d, "m.gguf", &b), Ok(()));
    // Modèle complet avec sa couche MTP intégrée : accepté.
    let mut kv = base("qwen35", 3);
    kv.push(("qwen35.nextn_predict_layers", Value::UInt(1)));
    let b = gguf(&kv, &["token_embd.weight", "blk.0.a.weight", "blk.1.a.weight", "blk.2.nextn.eh_proj.weight"]);
    assert_eq!(check(&d, "full.gguf", &b), Ok(()));
    // Même sans la couche MTP.
    let b = gguf(&kv, &["token_embd.weight", "blk.0.a.weight", "blk.1.a.weight"]);
    assert_eq!(check(&d, "trunk.gguf", &b), Ok(()));
  }

  #[test]
  fn tete_mtp_refusee() {
    // Reproduit mtp-Qwen3.8-27B-Q4_0.gguf : block_count 65, nextn 1, seul blk.64 présent.
    let d = dir("mtp");
    let mut kv = base("qwen35", 65);
    kv.push(("qwen35.nextn_predict_layers", Value::UInt(1)));
    let b = gguf(
      &kv,
      &["output.weight", "token_embd.weight", "blk.64.attn_q.weight", "blk.64.nextn.eh_proj.weight", "blk.64.nextn.enorm.weight"],
    );
    let e = check(&d, "mtp-Qwen3.8-27B-Q4_0.gguf", &b).unwrap_err();
    assert!(e.contains("mtp-Qwen3.8-27B-Q4_0.gguf") && e.contains("tête MTP"), "{e}");
  }

  #[test]
  fn annexes_refusees() {
    let d = dir("annexes");
    let b = gguf(&[("general.architecture", st("clip")), ("general.type", st("mmproj"))], &["v.patch_embd.weight"]);
    assert!(check(&d, "mmproj-F16.gguf", &b).unwrap_err().contains("projecteur de vision"));
    let b = gguf(&[("general.architecture", st("clip"))], &["v.patch_embd.weight"]);
    assert!(check(&d, "old-mmproj.gguf", &b).unwrap_err().contains("projecteur de vision"));
    let b = gguf(&[("general.architecture", st("llama")), ("general.type", st("adapter"))], &["blk.0.attn_q.weight.lora_a"]);
    assert!(check(&d, "lora.gguf", &b).unwrap_err().contains("adaptateur LoRA"));
    let b = gguf(&[("general.type", st("imatrix"))], &["blk.0.attn_q.weight.in_sum2"]);
    assert!(check(&d, "imatrix_unsloth.gguf", &b).unwrap_err().contains("matrice d'importance"));
    let b = gguf(&[("general.name", st("x"))], &["token_embd.weight"]);
    assert!(check(&d, "sans-arch.gguf", &b).unwrap_err().contains("architecture"));
    let b = gguf(&base("llama", 1), &["blk.0.attn_norm.weight"]);
    assert!(check(&d, "sans-vocab.gguf", &b).unwrap_err().contains("token_embd"));
    let b = gguf(&base("llama", 3), &["token_embd.weight", "blk.0.a.weight", "blk.2.a.weight"]);
    assert!(check(&d, "trou.gguf", &b).unwrap_err().contains("1 couche(s) sur 3"));
  }

  #[test]
  fn fichiers_invalides() {
    let d = dir("invalides");
    assert!(check(&d, "vide.gguf", b"").unwrap_err().contains("n'est pas un fichier GGUF valide"));
    assert!(check(&d, "texte.gguf", b"hello world, pas un gguf").unwrap_err().contains("signature"));
    let b = gguf(&base("llama", 1), &["token_embd.weight", "blk.0.a.weight"]);
    assert!(check(&d, "tronque.gguf", &b[..b.len() - 10]).unwrap_err().contains("tronqué"));
    let mut v1 = b.clone();
    v1[4] = 1;
    assert!(check(&d, "v1.gguf", &v1).unwrap_err().contains("version GGUF 1"));
    // Longueur de chaîne démesurée : erreur, pas d'allocation géante.
    let mut big = b"GGUF".to_vec();
    big.extend(3u32.to_le_bytes());
    big.extend(0u64.to_le_bytes());
    big.extend(1u64.to_le_bytes());
    big.extend(u64::MAX.to_le_bytes());
    assert!(check(&d, "enorme.gguf", &big).is_err());
    assert!(check_model(&d.0.join("absent.gguf")).unwrap_err().contains("ouverture impossible"));
  }

  #[test]
  fn modele_decoupe() {
    let d = dir("split");
    let mut kv = base("llama", 2);
    kv.push(("split.count", Value::UInt(2)));
    let p1 = gguf(&kv, &["token_embd.weight", "blk.0.a.weight"]);
    let p2 = gguf(&[("split.count", Value::UInt(2))], &["blk.1.a.weight"]);
    let first = d.0.join("big-00001-of-00002.gguf");
    std::fs::write(&first, &p1).unwrap();
    let e = check_model(&first).unwrap_err();
    assert!(e.contains("Partie manquante") && e.contains("big-00002-of-00002.gguf"), "{e}");
    std::fs::write(d.0.join("big-00002-of-00002.gguf"), &p2).unwrap();
    assert_eq!(check_model(&first), Ok(()));
  }

  #[test]
  fn tampon_partiel() {
    let mut kv = base("llama", 2);
    kv.push(("llama.context_length", Value::UInt(4096)));
    let b = gguf(&kv, &["token_embd.weight", "blk.0.a.weight", "blk.1.a.weight"]);
    let total = b.len() as u64 + 1000; // données des tenseurs après l'en-tête
    // Tout préfixe strict : « données insuffisantes », jamais une erreur de format.
    for n in 0..b.len() {
      assert_eq!(parse_header(&b[..n], total).unwrap_err(), HeaderError::Incomplete, "préfixe de {n} octets");
    }
    let h = parse_header(&b, total).unwrap();
    assert_eq!(h.tensors.len(), 3);
    assert_eq!(check_kind("m.gguf", &h).as_deref(), Ok("llama"));
    assert_eq!(check_tensors("m.gguf", "llama", &h, &[]), Ok(()));
    let info = model_info(&h, &[]);
    assert_eq!(info.architecture.as_deref(), Some("llama"));
    assert_eq!((info.block_count, info.context_length, info.param_count), (Some(2), Some(4096), Some(48)));
    // Fichier réellement plus court que l'en-tête : tronqué, pas « insuffisant ».
    let e = parse_header(&b[..b.len() - 3], b.len() as u64 - 3).unwrap_err();
    assert_eq!(e, HeaderError::Invalid("en-tête tronqué".into()));
    assert!(matches!(parse_header(b"GGUX\0\0\0\0", 1 << 20), Err(HeaderError::Invalid(e)) if e.contains("signature")));
    // Longueur de chaîne démesurée dans un tampon partiel : erreur immédiate, pas d'attente.
    let mut big = b"GGUF".to_vec();
    big.extend(3u32.to_le_bytes());
    big.extend(0u64.to_le_bytes());
    big.extend(1u64.to_le_bytes());
    big.extend(u64::MAX.to_le_bytes());
    assert!(matches!(parse_header(&big, 1 << 30), Err(HeaderError::Invalid(_))));
  }

  #[test]
  fn tete_mtp_depuis_tampon() {
    let mut kv = base("qwen35", 65);
    kv.push(("qwen35.nextn_predict_layers", Value::UInt(1)));
    let b = gguf(&kv, &["token_embd.weight", "blk.64.attn_q.weight", "blk.64.nextn.eh_proj.weight"]);
    let h = parse_header(&b, 1 << 30).unwrap();
    let arch = check_kind("draft.gguf", &h).unwrap();
    let e = check_tensors("draft.gguf", &arch, &h, &[]).unwrap_err();
    // Même message que check_model.
    let d = dir("mtp-tampon");
    assert_eq!(check(&d, "draft.gguf", &b).unwrap_err(), e);
    assert!(e.contains("tête MTP"), "{e}");
  }

  #[test]
  fn etiquette_de_taille() {
    assert_eq!(parse_size_label("27B"), Some(27_000_000_000));
    assert_eq!(parse_size_label("0.6B"), Some(600_000_000));
    assert_eq!(parse_size_label("8x7B"), Some(56_000_000_000));
    assert_eq!(parse_size_label("235B-A22B"), Some(235_000_000_000));
    assert_eq!(parse_size_label("125M"), Some(125_000_000));
    assert_eq!(parse_size_label("grand"), None);
    assert_eq!(parse_size_label(""), None);
    let h = parse_header(&gguf(&[("general.architecture", st("llama")), ("general.size_label", st("4B"))], &[]), 1 << 20).unwrap();
    assert_eq!(model_info(&h, &[]).param_count, Some(4_000_000_000));
  }

  #[test]
  fn meta_architecture() {
    let kv = vec![
      ("general.architecture", st("llama")),
      ("llama.block_count", Value::UInt(32)),
      ("llama.attention.head_count", Value::UInt(32)),
      ("llama.attention.head_count_kv", Value::UInt(8)),
      ("llama.embedding_length", Value::UInt(4096)),
      ("llama.context_length", Value::UInt(131072)),
    ];
    let h = parse_header(&gguf(&kv, &["token_embd.weight"]), 1 << 20).unwrap();
    let m = arch_meta(&h);
    assert_eq!((m.block_count, m.head_count_kv, m.context_length), (Some(32), Some(8), Some(131072)));
    // key_length absent : embedding_length / head_count.
    assert_eq!((m.head_dim_k(), m.head_dim_v(), m.n_head_kv()), (Some(128), Some(128), Some(8)));
    // head_count_kv par couche (tableau) : ignoré, repli sur head_count ; longueurs explicites.
    let kv = vec![
      ("general.architecture", st("gemma3")),
      ("gemma3.attention.head_count", Value::UInt(16)),
      ("gemma3.attention.head_count_kv", Value::Array),
      ("gemma3.attention.key_length", Value::UInt(256)),
      ("gemma3.attention.value_length", Value::UInt(192)),
    ];
    let m = arch_meta(&parse_header(&gguf(&kv, &[]), 1 << 20).unwrap());
    assert_eq!((m.head_count_kv, m.n_head_kv(), m.head_dim_k(), m.head_dim_v()), (None, Some(16), Some(256), Some(192)));
    assert_eq!(m.block_count, None);
    // Sans architecture : tout absent.
    let m = arch_meta(&parse_header(&gguf(&[("general.name", st("x"))], &[]), 1 << 20).unwrap());
    assert_eq!(m, ArchMeta::default());
    // Lecture depuis un fichier.
    let d = dir("meta");
    let p = d.0.join("m.gguf");
    std::fs::write(&p, gguf(&base("llama", 4), &["token_embd.weight"])).unwrap();
    assert_eq!(read_arch_meta(&p).unwrap().block_count, Some(4));
    assert!(read_arch_meta(&d.0.join("absent.gguf")).is_err());
  }

  /// Test manuel : LUCANIA_TEST_GGUF=<fichier> cargo test --lib gguf -- --ignored --nocapture
  #[test]
  #[ignore]
  fn verification_reelle() {
    let Ok(path) = std::env::var("LUCANIA_TEST_GGUF") else { return };
    let start = std::time::Instant::now();
    let r = check_model(Path::new(&path));
    eprintln!("vérification en {:?} : {r:?}", start.elapsed());
  }
}
