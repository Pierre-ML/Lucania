//! Petits fichiers de configuration JSON (dossier local de l'app) : lecture tolérante, écriture
//! atomique (fichier `.tmp` puis renommage).

use std::path::Path;

use serde::Serialize;
use serde::de::DeserializeOwned;

/// Lit un fichier JSON ; absent ou illisible : `None`.
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
  let text = std::fs::read_to_string(path).ok()?;
  serde_json::from_str(&text).ok()
}

/// Écrit un fichier JSON sans jamais laisser de fichier tronqué.
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
  let text = serde_json::to_string_pretty(value).map_err(|e| format!("Configuration illisible : {e}"))?;
  if let Some(dir) = path.parent() {
    std::fs::create_dir_all(dir).map_err(|e| format!("Création du dossier impossible : {e}"))?;
  }
  let mut tmp = path.as_os_str().to_owned();
  tmp.push(".tmp");
  let tmp = std::path::PathBuf::from(tmp);
  std::fs::write(&tmp, text).map_err(|e| format!("Enregistrement impossible : {e}"))?;
  std::fs::rename(&tmp, path).map_err(|e| {
    let _ = std::fs::remove_file(&tmp);
    format!("Enregistrement impossible : {e}")
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn ecriture_atomique() {
    let dir = std::env::temp_dir().join(format!("lucania-localfile-{}", std::process::id()));
    let path = dir.join("x.json");
    write_json(&path, &serde_json::json!({ "a": 1 })).unwrap();
    write_json(&path, &serde_json::json!({ "a": 2 })).unwrap();
    let v: serde_json::Value = read_json(&path).unwrap();
    assert_eq!(v["a"], 2);
    assert!(!dir.join("x.json.tmp").exists());
    assert!(read_json::<serde_json::Value>(&dir.join("absent.json")).is_none());
    let _ = std::fs::remove_dir_all(dir);
  }
}
