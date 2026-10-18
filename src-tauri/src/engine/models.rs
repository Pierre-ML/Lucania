//! Dossier des modèles : liste des fichiers GGUF et résolution sûre d'un identifiant.

use std::path::{Path, PathBuf};

use super::types::ModelEntry;

fn has_gguf_ext(name: &str) -> bool {
  name.len() > 5 && name.is_char_boundary(name.len() - 5) && name[name.len() - 5..].eq_ignore_ascii_case(".gguf")
}

/// Fichier d'un modèle découpé (`xxx-00002-of-00003.gguf`) autre que le premier : llama.cpp
/// charge les parties suivantes tout seul, on ne les liste pas.
fn is_secondary_split(stem: &str) -> bool {
  // Motif final (octets) : "-NNNNN-of-NNNNN"
  let b = stem.as_bytes();
  if b.len() < 15 {
    return false;
  }
  let t = &b[b.len() - 15..];
  let digits = |r: std::ops::Range<usize>| t[r].iter().all(u8::is_ascii_digit);
  t[0] == b'-' && digits(1..6) && &t[6..10] == b"-of-" && digits(10..15) && &t[1..6] != b"00001"
}

/// Liste récursive des *.gguf du dossier (les téléchargements *.part sont ignorés), triée par
/// identifiant sans tenir compte de la casse.
pub fn list_models(dir: &Path) -> Result<Vec<ModelEntry>, String> {
  let mut out = Vec::new();
  if !dir.is_dir() {
    return Ok(out);
  }
  let mut stack = vec![(dir.to_path_buf(), String::new())];
  while let Some((current, prefix)) = stack.pop() {
    let entries = std::fs::read_dir(&current)
      .map_err(|e| format!("Lecture du dossier des modèles impossible ({}) : {e}", current.display()))?;
    for entry in entries.flatten() {
      let Ok(file_type) = entry.file_type() else { continue };
      let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
      let id = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
      // Les liens symboliques de dossiers ne sont pas suivis (pas de boucle possible).
      if file_type.is_dir() {
        stack.push((entry.path(), id));
        continue;
      }
      if !has_gguf_ext(&name) {
        continue;
      }
      let stem = &name[..name.len() - 5];
      if is_secondary_split(stem) {
        continue;
      }
      let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
      out.push(ModelEntry { id, name: stem.to_string(), size_bytes });
    }
  }
  out.sort_by(|a, b| a.id.to_lowercase().cmp(&b.id.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
  Ok(out)
}

/// Vérifie un identifiant de modèle et renvoie le chemin du fichier. Refuse toute tentative de
/// sortir du dossier des modèles (« .. », chemin absolu, lettre de lecteur, antislash).
pub fn resolve_model(dir: &Path, id: &str) -> Result<PathBuf, String> {
  let invalid = || format!("Identifiant de modèle invalide : « {id} »");
  if id.is_empty()
    || id.contains("..")
    || id.starts_with('/')
    || id.contains('\\')
    || id.contains(':')
    || id.contains('\0')
    || !has_gguf_ext(id)
  {
    return Err(invalid());
  }
  let mut path = dir.to_path_buf();
  for part in id.split('/') {
    if part.is_empty() || part == "." {
      return Err(invalid());
    }
    path.push(part);
  }
  if !path.is_file() {
    return Err(format!("Modèle introuvable : « {id} »"));
  }
  // Défense supplémentaire : le fichier réel (liens résolus) doit rester dans le dossier.
  if let (Ok(real), Ok(base)) = (path.canonicalize(), dir.canonicalize()) {
    if !real.starts_with(&base) {
      return Err(invalid());
    }
  }
  Ok(path)
}

/// Première partie d'un modèle découpé (`xxx-00001-of-00003.gguf`) : renvoie ("xxx", 3).
fn first_split(stem: &str) -> Option<(&str, u32)> {
  let b = stem.as_bytes();
  if b.len() < 16 || !stem.is_char_boundary(b.len() - 15) {
    return None;
  }
  let (prefix, tail) = stem.split_at(stem.len() - 15);
  let total: u32 = tail.strip_prefix("-00001-of-")?.parse().ok()?;
  (tail.len() == 15 && tail[10..].bytes().all(|c| c.is_ascii_digit()) && total >= 1).then_some((prefix, total))
}

/// Fichiers d'un modèle : le fichier lui-même et, pour la première partie d'un modèle découpé,
/// les parties suivantes présentes à côté.
fn model_files(path: &Path) -> Vec<PathBuf> {
  let mut out = vec![path.to_path_buf()];
  let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
  if !has_gguf_ext(name) {
    return out;
  }
  let (stem, ext) = name.split_at(name.len() - 5);
  if let (Some((prefix, total)), Some(dir)) = (first_split(stem), path.parent()) {
    out.extend((2..=total).map(|i| dir.join(format!("{prefix}-{i:05}-of-{total:05}{ext}"))).filter(|p| p.is_file()));
  }
  out
}

/// Supprime les fichiers du modèle `path` (déjà résolu), puis les dossiers devenus vides
/// jusqu'au dossier des modèles (exclu).
pub fn delete_model_files(dir: &Path, path: &Path) -> Result<(), String> {
  for file in model_files(path) {
    match std::fs::remove_file(&file) {
      Ok(()) => {}
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
      Err(e) => {
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        return Err(format!("Suppression de « {name} » impossible : {e}"));
      }
    }
  }
  let mut parent = path.parent();
  while let Some(p) = parent {
    if p == dir || !p.starts_with(dir) || std::fs::remove_dir(p).is_err() {
      break;
    }
    parent = p.parent();
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn suppression() {
    let root = std::env::temp_dir().join(format!("lucania-delete-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let deep = root.join("org/repo/Q4");
    std::fs::create_dir_all(&deep).unwrap();
    for f in ["m-00001-of-00003.gguf", "m-00002-of-00003.gguf", "m-00003-of-00003.gguf"] {
      std::fs::write(deep.join(f), b"x").unwrap();
    }
    std::fs::write(root.join("org/autre.gguf"), b"x").unwrap();
    let path = resolve_model(&root, "org/repo/Q4/m-00001-of-00003.gguf").unwrap();
    assert_eq!(model_files(&path).len(), 3);
    delete_model_files(&root, &path).unwrap();
    // Dossiers vides supprimés ; « org » contient encore un modèle.
    assert!(!root.join("org/repo").exists());
    assert!(root.join("org/autre.gguf").is_file());
    let seul = resolve_model(&root, "org/autre.gguf").unwrap();
    assert_eq!(model_files(&seul).len(), 1);
    delete_model_files(&root, &seul).unwrap();
    assert!(!root.join("org").exists());
    assert!(root.is_dir());
    assert_eq!(first_split("m-00001-of-00003"), Some(("m", 3)));
    assert_eq!(first_split("m-00002-of-00003"), None);
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn extension_et_parties() {
    assert!(has_gguf_ext("a.GGUF"));
    assert!(!has_gguf_ext("a.gguf.part"));
    assert!(!is_secondary_split("Qwen3-8B-Q4_K_M"));
    assert!(!is_secondary_split("big-00001-of-00003"));
    assert!(is_secondary_split("big-00002-of-00003"));
  }

  #[test]
  fn identifiants_refuses() {
    let dir = std::env::temp_dir();
    for bad in ["", "../x.gguf", "/x.gguf", "C:/x.gguf", "c:x.gguf", "a\\b.gguf", "a//b.gguf", "./a.gguf", "a.bin"] {
      assert!(resolve_model(&dir, bad).is_err(), "{bad}");
    }
  }

  #[test]
  fn liste_recursive() {
    let root = std::env::temp_dir().join(format!("lucania-models-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("unsloth/Qwen")).unwrap();
    std::fs::write(root.join("b.gguf"), b"x").unwrap();
    std::fs::write(root.join("A.gguf"), b"xy").unwrap();
    std::fs::write(root.join("c.gguf.part"), b"x").unwrap();
    std::fs::write(root.join("unsloth/Qwen/q-00001-of-00002.gguf"), b"x").unwrap();
    std::fs::write(root.join("unsloth/Qwen/q-00002-of-00002.gguf"), b"x").unwrap();
    let list = list_models(&root).unwrap();
    let ids: Vec<_> = list.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["A.gguf", "b.gguf", "unsloth/Qwen/q-00001-of-00002.gguf"]);
    assert_eq!(list[0].name, "A");
    assert_eq!(list[0].size_bytes, 2);
    assert!(resolve_model(&root, "unsloth/Qwen/q-00001-of-00002.gguf").is_ok());
    assert!(resolve_model(&root, "absent.gguf").is_err());
    let _ = std::fs::remove_dir_all(&root);
  }
}
