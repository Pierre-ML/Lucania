//! Lecture de l'en-tête GGUF (métadonnées et noms de tenseurs, jamais les poids) pour refuser,
//! avant llama.cpp, les fichiers qui ne sont pas des modèles de langage autonomes.
//!
//! Raison : llama.cpp accepte certains fichiers annexes (ex. tête MTP « mtp-*.gguf » : seule la
//! dernière couche et les tenseurs `nextn.*`) puis lit des tenseurs absents à la création du
//! contexte : violation d'accès, l'app se ferme sans message. Le parseur est écrit en Rust pur :
//! un fichier malformé donne une erreur, jamais un arrêt du processus.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

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

#[derive(Debug, Default)]
struct Header {
  kv: HashMap<String, Value>,
  tensors: Vec<String>,
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
}

/// Lecteur borné par la taille du fichier : un saut ou une lecture au-delà échoue.
struct Reader {
  inner: BufReader<File>,
  pos: u64,
  len: u64,
}

impl Reader {
  fn read<const N: usize>(&mut self) -> Result<[u8; N], String> {
    let mut b = [0u8; N];
    self.inner.read_exact(&mut b).map_err(|_| "en-tête tronqué".to_string())?;
    self.pos += N as u64;
    Ok(b)
  }

  fn u32(&mut self) -> Result<u32, String> {
    Ok(u32::from_le_bytes(self.read()?))
  }

  fn u64(&mut self) -> Result<u64, String> {
    Ok(u64::from_le_bytes(self.read()?))
  }

  fn skip(&mut self, n: u64) -> Result<(), String> {
    let end = self.pos.checked_add(n).filter(|&e| e <= self.len).ok_or("en-tête tronqué")?;
    let step = i64::try_from(n).map_err(|_| "en-tête tronqué")?;
    self.inner.seek_relative(step).map_err(|e| format!("lecture impossible : {e}"))?;
    self.pos = end;
    Ok(())
  }

  /// Chaîne GGUF (u64 + octets) ; `None` si plus longue que `max` (alors sautée).
  fn string(&mut self, max: u64) -> Result<Option<String>, String> {
    let n = self.u64()?;
    if n > max {
      self.skip(n)?;
      return Ok(None);
    }
    if self.pos + n > self.len {
      return Err("en-tête tronqué".into());
    }
    let mut b = vec![0u8; n as usize];
    self.inner.read_exact(&mut b).map_err(|_| "en-tête tronqué".to_string())?;
    self.pos += n;
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

  fn value(&mut self, t: u32) -> Result<Value, String> {
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
          self.skip(n.checked_mul(size).ok_or("en-tête tronqué")?)?;
        }
        Value::Array
      }
      10 => Value::UInt(self.u64()?),
      11 => Value::Int(i64::from_le_bytes(self.read()?)),
      12 => {
        self.skip(8)?;
        Value::Other
      }
      _ => return Err(format!("type de valeur inconnu ({t})")),
    })
  }
}

/// Lit les métadonnées et les noms de tenseurs d'un fichier GGUF (versions 2 et 3).
fn read_header(path: &Path) -> Result<Header, String> {
  let file = File::open(path).map_err(|e| format!("ouverture impossible : {e}"))?;
  let len = file.metadata().map_err(|e| format!("lecture impossible : {e}"))?.len();
  let mut r = Reader { inner: BufReader::with_capacity(1 << 16, file), pos: 0, len };
  if &r.read::<4>()? != MAGIC {
    return Err("signature GGUF absente".into());
  }
  let version = r.u32()?;
  if !(2..=3).contains(&version) {
    return Err(format!("version GGUF {version} non prise en charge"));
  }
  let n_tensors = r.u64()?;
  let n_kv = r.u64()?;
  if n_tensors > MAX_TENSORS || n_kv > MAX_KV {
    return Err("en-tête incohérent".into());
  }
  let mut h = Header::default();
  for _ in 0..n_kv {
    let key = r.string(MAX_KEY_LEN)?.ok_or("clé trop longue")?;
    let t = r.u32()?;
    let v = r.value(t)?;
    h.kv.insert(key, v);
  }
  for _ in 0..n_tensors {
    let name = r.string(MAX_KEY_LEN)?.ok_or("nom de tenseur trop long")?;
    let n_dims = r.u32()?;
    if n_dims > MAX_DIMS {
      return Err("tenseur incohérent".into());
    }
    // Dimensions, type, décalage : inutiles ici.
    r.skip(u64::from(n_dims) * 8 + 4 + 8)?;
    h.tensors.push(name);
  }
  Ok(h)
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

/// Vérifie qu'un GGUF est un modèle de langage autonome avant de le confier à llama.cpp.
pub fn check_model(path: &Path) -> Result<(), String> {
  let name = display(path);
  let unreadable = |e: String| format!("« {name} » n'est pas un fichier GGUF valide ({e}).");
  let annex = |what: &str| format!("« {name} » n'est pas un modèle de chat autonome (fichier annexe : {what}).");
  let h = read_header(path).map_err(unreadable)?;

  if let Some(kind) = h.str("general.type") {
    match kind {
      "model" => {}
      "mmproj" => return Err(annex("projecteur de vision")),
      "adapter" => return Err(annex("adaptateur LoRA")),
      "imatrix" => return Err(annex("matrice d'importance de quantification")),
      other => return Err(annex(&format!("type « {other} »"))),
    }
  }
  let Some(arch) = h.str("general.architecture").map(str::to_string) else {
    return Err(format!("« {name} » n'indique pas d'architecture : ce n'est pas un modèle de langage."));
  };
  if arch == "clip" {
    return Err(annex("projecteur de vision"));
  }

  // Tenseurs de toutes les parties d'un modèle découpé (chaque partie a son propre en-tête).
  let mut tensors: HashSet<String> = h.tensors.iter().cloned().collect();
  let count = h.uint("split.count").unwrap_or(1);
  if count > 1 {
    let parts = split_paths(path, count).ok_or_else(|| format!("« {name} » : nom de modèle découpé non reconnu."))?;
    for part in parts.iter().skip(1) {
      if !part.is_file() {
        return Err(format!("Partie manquante du modèle « {name} » : « {} ».", display(part)));
      }
      let ph = read_header(part).map_err(|e| format!("« {} » n'est pas un fichier GGUF valide ({e}).", display(part)))?;
      tensors.extend(ph.tensors);
    }
  }

  if !tensors.contains("token_embd.weight") {
    return Err(format!("« {name} » ne contient pas de table de vocabulaire (token_embd) : ce n'est pas un modèle de chat autonome."));
  }

  // Couches du tronc : toutes doivent être présentes. Les têtes MTP (`<arch>.nextn_predict_layers`)
  // sont comptées dans block_count mais facultatives.
  let blocks: HashSet<u64> = tensors.iter().filter_map(|t| block_index(t)).collect();
  let block_count = h.uint(&format!("{arch}.block_count")).unwrap_or(0);
  let nextn = h.uint(&format!("{arch}.nextn_predict_layers")).unwrap_or(0);
  let trunk = block_count.saturating_sub(nextn);
  if !blocks.is_empty() && trunk > 0 {
    let present = blocks.iter().filter(|&&b| b < trunk).count() as u64;
    if present < trunk {
      let mtp = tensors.iter().any(|t| t.contains(".nextn.")) || present == 0;
      if mtp {
        return Err(annex("tête MTP de prédiction multi-jetons, à utiliser avec le modèle complet"));
      }
      return Err(format!("« {name} » est incomplet : {} couche(s) sur {trunk} absentes du fichier.", trunk - present));
    }
  }
  Ok(())
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
