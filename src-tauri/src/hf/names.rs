//! Fonctions pures (testées sans réseau) : validation des entrées, noms de fichiers GGUF
//! (quantification, parties découpées), regroupement des fichiers d'un dépôt et déduction d'un
//! téléchargement interrompu à partir de son fichier `.part`.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

/// Nombre maximal de fichiers par téléchargement.
pub const MAX_FILES: usize = 10;

/// Suffixe des fichiers en cours de téléchargement.
pub const PART_EXT: &str = ".part";

pub fn has_gguf_ext(name: &str) -> bool {
  name.len() > 5 && name.is_char_boundary(name.len() - 5) && name[name.len() - 5..].eq_ignore_ascii_case(".gguf")
}

// ---------------------------------------------------------------------------------------------
// Validation (anti-traversée)
// ---------------------------------------------------------------------------------------------

fn valid_repo_part(s: &str) -> bool {
  let b = s.as_bytes();
  !b.is_empty()
    && b.len() <= 96
    && b[0].is_ascii_alphanumeric()
    && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
    // Windows ignore les points finaux d'un nom de dossier : « a. » désignerait « a ».
    && !s.ends_with('.')
    && !s.contains("..")
}

/// Identifiant de dépôt `org/nom` : chaque moitié vérifie `^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$`.
pub fn valid_repo(repo: &str) -> bool {
  let mut parts = repo.split('/');
  matches!((parts.next(), parts.next(), parts.next()), (Some(a), Some(b), None) if valid_repo_part(a) && valid_repo_part(b))
}

/// Chemin d'un fichier dans un dépôt : relatif, séparateurs "/", segments non vides, sans
/// « . » ni « .. », sans antislash, deux-points ni caractère interdit sous Windows, extension
/// .gguf.
pub fn valid_file(path: &str) -> bool {
  if path.is_empty() || path.len() > 512 || !has_gguf_ext(path) || path.starts_with('/') {
    return false;
  }
  path.split('/').all(|seg| {
    !seg.is_empty()
      && seg != "."
      && !seg.contains("..")
      && !seg.ends_with('.')
      && !seg.ends_with(' ')
      && !seg.chars().any(|c| c.is_control() || matches!(c, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'))
  })
}

/// Destination d'un fichier : `<models>/<org>/<nom>/<chemin>`. Revérifie après jointure que le
/// chemin ne contient que des composants ordinaires et reste sous le dossier des modèles.
pub fn dest_path(models_dir: &Path, repo: &str, file: &str) -> Result<PathBuf, String> {
  if !valid_repo(repo) {
    return Err(format!("Dépôt invalide : « {repo} »"));
  }
  if !valid_file(file) {
    return Err(format!("Fichier invalide : « {file} »"));
  }
  let mut path = models_dir.to_path_buf();
  for seg in repo.split('/').chain(file.split('/')) {
    path.push(seg);
  }
  let rel = path.strip_prefix(models_dir).map_err(|_| format!("Fichier invalide : « {file} »"))?;
  if !rel.components().all(|c| matches!(c, Component::Normal(_))) {
    return Err(format!("Fichier invalide : « {file} »"));
  }
  Ok(path)
}

/// `<dest>.part`
pub fn part_path(dest: &Path) -> PathBuf {
  let mut s = dest.as_os_str().to_owned();
  s.push(PART_EXT);
  PathBuf::from(s)
}

// ---------------------------------------------------------------------------------------------
// Noms de fichiers GGUF
// ---------------------------------------------------------------------------------------------

/// Partie d'un modèle découpé : `<préfixe>-00002-of-00003.gguf` -> ("<préfixe>", 2, 3).
pub fn split_info(path: &str) -> Option<(&str, u32, u32)> {
  if !has_gguf_ext(path) {
    return None;
  }
  let stem = &path[..path.len() - 5];
  let b = stem.as_bytes();
  if b.len() < 16 {
    return None;
  }
  let t = &b[b.len() - 15..];
  let digits = |r: std::ops::Range<usize>| t[r].iter().all(u8::is_ascii_digit);
  if !(t[0] == b'-' && digits(1..6) && &t[6..10] == b"-of-" && digits(10..15)) {
    return None;
  }
  let tail = &stem[stem.len() - 15..];
  let index: u32 = tail[1..6].parse().ok()?;
  let total: u32 = tail[10..15].parse().ok()?;
  (index >= 1 && index <= total).then(|| (&stem[..stem.len() - 15], index, total))
}

/// Noms de toutes les parties d'un modèle découpé, dans l'ordre.
pub fn split_names(prefix: &str, total: u32) -> Vec<String> {
  (1..=total).map(|i| format!("{prefix}-{i:05}-of-{total:05}.gguf")).collect()
}

/// Nom affiché : nom du fichier sans dossier, sans ".gguf" ni suffixe "-00001-of-0000N".
pub fn display_name(path: &str) -> String {
  let file = path.rsplit('/').next().unwrap_or(path);
  match split_info(file) {
    Some((prefix, _, _)) => prefix.to_string(),
    None if has_gguf_ext(file) => file[..file.len() - 5].to_string(),
    None => file.to_string(),
  }
}

/// Quantification ggml : Q4_K_M, Q8_0, Q4_0_4_4, IQ2_XXS, IQ4_NL, TQ1_0, Q4_K_XL…
fn is_ggml_quant(t: &str) -> bool {
  let Some(rest) = t.strip_prefix("IQ").or_else(|| t.strip_prefix("TQ")).or_else(|| t.strip_prefix('Q')) else {
    return false;
  };
  let mut parts = rest.split('_');
  let bits = parts.next().unwrap_or("");
  if bits.len() != 1 || !bits.as_bytes()[0].is_ascii_digit() {
    return false;
  }
  let tail: Vec<&str> = parts.collect();
  !tail.is_empty()
    && tail.len() <= 4
    && tail.iter().all(|p| !p.is_empty() && p.len() <= 3 && p.bytes().all(|c| c.is_ascii_alphanumeric()))
}

fn is_quant(t: &str) -> bool {
  matches!(t, "F16" | "BF16" | "F32" | "FP16" | "FP32" | "NVFP4")
    || t == "MXFP4"
    || t.strip_prefix("MXFP4_").is_some_and(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_alphanumeric()))
    || is_ggml_quant(t)
}

/// Quantification lue dans un nom (insensible à la casse, renvoyée en majuscules), sinon None.
/// Le dernier segment reconnu l'emporte (« Qwen3-4B-UD-Q4_K_XL » -> « Q4_K_XL »).
pub fn quant(name: &str) -> Option<String> {
  let upper = name.to_ascii_uppercase();
  upper.split(['-', '.', ' ', '/']).rev().find(|t| is_quant(t)).map(str::to_string)
}

// ---------------------------------------------------------------------------------------------
// Regroupement des fichiers d'un dépôt
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
  pub name: String,
  /// Chemins dans le dépôt, triés (première partie en tête).
  pub files: Vec<String>,
  pub size_bytes: u64,
}

/// Fichier GGUF annexe, inutilisable seul comme modèle de chat (chemin complet dans le dépôt,
/// casse ignorée) :
/// - projecteur multimodal : « mmproj » ;
/// - tête MTP (prédiction multi-jetons, à charger avec le modèle complet) : segment « mtp » ou
///   « nextn » (dossier `MTP/`, `mtp-Qwen3.8-27B-Q4_0.gguf`…) ;
/// - matrice d'importance de quantification : « imatrix » (`imatrix_unsloth.gguf`).
///
/// Les modèles « draft » (petits modèles pour le décodage spéculatif) restent proposés : ce sont
/// des modèles complets. Les adaptateurs LoRA, sans nom normalisé, sont refusés au chargement
/// par le moteur (`general.type = adapter`).
pub fn is_annex_file(path: &str) -> bool {
  let lower = path.to_ascii_lowercase();
  lower.contains("mmproj")
    || lower.contains("imatrix")
    || lower.split(['/', '-', '_', '.', ' ']).any(|seg| seg == "mtp" || seg == "nextn")
}

/// Garde les .gguf hors fichiers annexes (`is_annex_file`), regroupe les modèles découpés
/// (groupes incomplets ignorés) et trie par taille croissante.
pub fn group_files(entries: &[(String, u64)]) -> Vec<Group> {
  let mut out = Vec::new();
  let mut splits: BTreeMap<(String, u32), BTreeMap<u32, (String, u64)>> = BTreeMap::new();
  for (path, size) in entries {
    if !valid_file(path) || is_annex_file(path) {
      continue;
    }
    match split_info(path) {
      Some((prefix, index, total)) => {
        splits.entry((prefix.to_string(), total)).or_default().insert(index, (path.clone(), *size));
      }
      None => out.push(Group { name: display_name(path), files: vec![path.clone()], size_bytes: *size }),
    }
  }
  for ((_, total), parts) in splits {
    if total as usize > MAX_FILES || !parts.keys().copied().eq(1..=total) {
      continue;
    }
    let files: Vec<String> = parts.values().map(|(p, _)| p.clone()).collect();
    let size_bytes = parts.values().map(|(_, s)| *s).sum();
    out.push(Group { name: display_name(&files[0]), files, size_bytes });
  }
  out.sort_by(|a, b| a.size_bytes.cmp(&b.size_bytes).then_with(|| a.name.cmp(&b.name)));
  out
}

// ---------------------------------------------------------------------------------------------
// Téléchargements interrompus
// ---------------------------------------------------------------------------------------------

/// Déduit (dépôt, fichiers) d'un `.part` donné par son chemin relatif au dossier des modèles
/// (séparateurs "/") : `<org>/<nom>/<chemin>.gguf.part`. Pour une partie de modèle découpé,
/// renvoie toutes les parties.
pub fn deduce_from_part(rel: &str) -> Option<(String, Vec<String>)> {
  let file_rel = rel.strip_suffix(PART_EXT)?;
  let mut it = file_rel.splitn(3, '/');
  let (org, name, file) = (it.next()?, it.next()?, it.next()?);
  let repo = format!("{org}/{name}");
  if !valid_repo(&repo) || !valid_file(file) {
    return None;
  }
  let files = match split_info(file) {
    Some((prefix, _, total)) if total as usize <= MAX_FILES => split_names(prefix, total),
    Some(_) => return None,
    None => vec![file.to_string()],
  };
  Some((repo, files))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn quantifications() {
    let cases = [
      ("Qwen3-4B-Q4_K_M", Some("Q4_K_M")),
      ("qwen2.5-7b-instruct-q5_k_s", Some("Q5_K_S")),
      ("Qwen3-4B-UD-Q4_K_XL", Some("Q4_K_XL")),
      ("Qwen3-4B-UD-IQ1_S", Some("IQ1_S")),
      ("Qwen3-4B-IQ4_NL", Some("IQ4_NL")),
      ("Qwen3-4B-IQ4_XS", Some("IQ4_XS")),
      ("Qwen3-4B-UD-IQ2_XXS", Some("IQ2_XXS")),
      ("Qwen3-4B-Q8_0", Some("Q8_0")),
      ("Qwen3-4B-Q4_0", Some("Q4_0")),
      ("Qwen3-4B-Q2_K", Some("Q2_K")),
      ("model.Q6_K", Some("Q6_K")),
      ("Qwen3-4B-BF16", Some("BF16")),
      ("phi-3-f16", Some("F16")),
      ("x-F32", Some("F32")),
      ("gpt-oss-20b-MXFP4", Some("MXFP4")),
      ("gpt-oss-120b-mxfp4_moe", Some("MXFP4_MOE")),
      ("bitnet-TQ1_0", Some("TQ1_0")),
      ("Qwen3-235B-A22B-Q4_K_M-00001-of-00003", Some("Q4_K_M")),
      ("Qwen3-4B", None),
      ("Llama-Q1", None),
      ("ggml-model", None),
    ];
    for (name, want) in cases {
      assert_eq!(quant(name).as_deref(), want, "{name}");
    }
  }

  #[test]
  fn parties_decoupees() {
    assert_eq!(split_info("Q4/big-Q4_K_M-00002-of-00003.gguf"), Some(("Q4/big-Q4_K_M", 2, 3)));
    assert_eq!(split_info("big-00001-of-00001.GGUF"), Some(("big", 1, 1)));
    assert_eq!(split_info("big-00004-of-00003.gguf"), None);
    assert_eq!(split_info("big-Q4_K_M.gguf"), None);
    assert_eq!(split_names("a/b", 2), ["a/b-00001-of-00002.gguf", "a/b-00002-of-00002.gguf"]);
    assert_eq!(display_name("Q4_K_M/big-Q4_K_M-00001-of-00003.gguf"), "big-Q4_K_M");
    assert_eq!(display_name("Qwen3-4B-Q4_K_M.gguf"), "Qwen3-4B-Q4_K_M");
  }

  #[test]
  fn regroupement() {
    let e = |p: &str, s: u64| (p.to_string(), s);
    let entries = vec![
      e(".gitattributes", 10),
      e("README.md", 10),
      e("Qwen3-4B-Q8_0.gguf", 400),
      e("Qwen3-4B-Q2_K.gguf", 100),
      e("mmproj-F16.gguf", 50),
      e("vision/MMPROJ-model.gguf", 50),
      // Annexes du dépôt unsloth/Qwen3.8-27B-GGUF : tête MTP (le plus petit fichier, en tête de
      // liste avant ce filtre) et matrice d'importance.
      e("MTP/mtp-Qwen3.8-27B-Q4_0.gguf", 20),
      e("imatrix_unsloth.gguf", 5),
      e("Qwen3-4B-Q4_K_M.nextn.gguf", 5),
      e("BF16/big-BF16-00002-of-00002.gguf", 30),
      e("BF16/big-BF16-00001-of-00002.gguf", 500),
      // Groupe incomplet : ignoré
      e("Q4/big-Q4-00001-of-00003.gguf", 1),
      e("Q4/big-Q4-00003-of-00003.gguf", 1),
    ];
    let groups = group_files(&entries);
    let names: Vec<_> = groups.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(names, ["Qwen3-4B-Q2_K", "Qwen3-4B-Q8_0", "big-BF16"]);
    assert_eq!(groups[2].files, ["BF16/big-BF16-00001-of-00002.gguf", "BF16/big-BF16-00002-of-00002.gguf"]);
    assert_eq!(groups[2].size_bytes, 530);
  }

  #[test]
  fn fichiers_annexes() {
    for annex in [
      "mmproj-F16.gguf",
      "MTP/mtp-Qwen3.8-27B-Q4_0.gguf",
      "mtp/model-Q4_0.gguf",
      "Qwen3.8-27B-MTP-Q8_0.gguf",
      "model_mtp.gguf",
      "imatrix_unsloth.gguf",
      "Qwen3-4B.imatrix.gguf",
      "x-nextn-Q4_0.gguf",
    ] {
      assert!(is_annex_file(annex), "{annex}");
    }
    for model in [
      "Qwen3.8-27B-Q4_0.gguf",
      "BF16/Qwen3.8-27B-BF16-00001-of-00002.gguf",
      "Qwen2.5-Coder-0.5B-Instruct-draft-Q8_0.gguf",
      "smtp-helper-Q4_K_M.gguf",
      "Mtproto-7B-Q4_0.gguf",
    ] {
      assert!(!is_annex_file(model), "{model}");
    }
  }

  #[test]
  fn validation_depots() {
    for ok in ["unsloth/Qwen3-4B-GGUF", "a/b", "TheBloke/Llama-2-7B-Chat-GGUF", "bartowski/Qwen2.5-7B_x"] {
      assert!(valid_repo(ok), "{ok}");
    }
    let long = format!("a/{}", "b".repeat(97));
    for bad in ["", "a", "a/b/c", "/a/b", "a/", "-a/b", "a/.b", "a/b.", "a/..", "a/b..c", "a\\b/c", "a/b c", "a/b:c", &long] {
      assert!(!valid_repo(bad), "{bad}");
    }
  }

  #[test]
  fn validation_chemins() {
    for ok in ["m.gguf", "Q4_K_M/m-00001-of-00002.gguf", "a b/m.GGUF"] {
      assert!(valid_file(ok), "{ok}");
    }
    for bad in [
      "", "m.bin", "m.gguf.part", "/m.gguf", "../m.gguf", "a/../m.gguf", "a/./m.gguf", "a//m.gguf", "a\\m.gguf",
      "C:/m.gguf", "c:m.gguf", "a./m.gguf", "a/m?.gguf", "a\0/m.gguf",
    ] {
      assert!(!valid_file(bad), "{bad:?}");
    }
    let dir = Path::new("models");
    let p = dest_path(dir, "unsloth/Qwen3-4B-GGUF", "Q4/m.gguf").unwrap();
    assert_eq!(p, Path::new("models").join("unsloth").join("Qwen3-4B-GGUF").join("Q4").join("m.gguf"));
    assert!(dest_path(dir, "unsloth/..", "m.gguf").is_err());
    assert!(dest_path(dir, "unsloth/x", "../../m.gguf").is_err());
    assert_eq!(part_path(&p).file_name().unwrap(), "m.gguf.part");
  }

  #[test]
  fn deduction_depuis_part() {
    assert_eq!(
      deduce_from_part("unsloth/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf.part"),
      Some(("unsloth/Qwen3-4B-GGUF".into(), vec!["Qwen3-4B-Q4_K_M.gguf".into()]))
    );
    assert_eq!(
      deduce_from_part("unsloth/Big-GGUF/Q4_K_M/Big-Q4_K_M-00002-of-00003.gguf.part"),
      Some((
        "unsloth/Big-GGUF".into(),
        vec![
          "Q4_K_M/Big-Q4_K_M-00001-of-00003.gguf".into(),
          "Q4_K_M/Big-Q4_K_M-00002-of-00003.gguf".into(),
          "Q4_K_M/Big-Q4_K_M-00003-of-00003.gguf".into(),
        ]
      ))
    );
    for bad in ["x.gguf.part", "org/x.gguf.part", "org/repo/x.gguf", "org/repo/x.bin.part", "org/../x.gguf.part", "o/r/b-00001-of-00011.gguf.part"] {
      assert_eq!(deduce_from_part(bad), None, "{bad}");
    }
  }
}
