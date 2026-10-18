//! Vérification à distance d'un GGUF, avant tout téléchargement : l'en-tête (métadonnées et
//! infos de tenseurs) est lu par requêtes Range sur `resolve/main/<chemin>` (mêmes hôtes,
//! redirections et jeton que les téléchargements), en morceaux croissants : 4 Mo pour la
//! première partie (1 Mo pour les suivantes d'un modèle découpé), doublés tant que l'en-tête
//! n'est pas complet, 64 Mo au plus par fichier. Les règles sont celles du moteur
//! (`engine::gguf`) : un fichier refusé ici l'aurait été au chargement, avec le même message.
//!
//! Résultats en cache : mémoire et `<app_local_data_dir>/hf-cache/checks.json`, clé = dépôt +
//! chemin + oid LFS + taille de chaque fichier (un fichier modifié sur Hugging Face est relu).
//! Les échecs réseau ne sont jamais mis en cache.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use reqwest::Client;
use serde::{Deserialize, Serialize};

use super::api::{self, PathInfo};
use super::types::FileCheck;
use super::{Hf, lock, log, names};
use crate::engine::gguf::{self, ArchMeta, Header, HeaderError, ModelInfo};

/// Premier morceau lu pour la première partie (métadonnées : vocabulaire, modèle de chat…).
const FIRST_CHUNK: u64 = 4 << 20;
/// Premier morceau lu pour les parties suivantes (peu de métadonnées).
const PART_CHUNK: u64 = 1 << 20;
/// Plafond de lecture par fichier.
const MAX_HEADER: u64 = 64 << 20;
const CACHE_FILE: &str = "checks.json";
/// 2 : ajout des métadonnées d'architecture (`meta`) pour l'estimation de la VRAM.
const CACHE_VERSION: u32 = 2;
const MAX_ENTRIES: usize = 1000;
/// Une demande identique (dépôt + fichiers) récente est servie sans rappeler l'API.
const RECENT_TTL: Duration = Duration::from_secs(600);

#[derive(Serialize, Deserialize)]
struct Stored {
  key: String,
  result: FileCheck,
}

#[derive(Serialize, Deserialize)]
struct DiskCache {
  version: u32,
  entries: Vec<Stored>,
}

#[derive(Default)]
pub(super) struct Cache {
  /// Entrées connues (les plus anciennes en tête), chargées depuis le disque au premier usage.
  entries: Option<Vec<Stored>>,
  recent: HashMap<String, (Instant, FileCheck)>,
}

fn cache_path(hf: &Hf) -> PathBuf {
  hf.inner.cache_dir.join(CACHE_FILE)
}

/// Charge le cache disque s'il ne l'est pas encore (fichier absent ou illisible : cache vide).
async fn ensure_loaded(hf: &Hf) {
  if lock(&hf.inner.checks).entries.is_some() {
    return;
  }
  let entries = match tokio::fs::read(cache_path(hf)).await {
    Ok(bytes) => serde_json::from_slice::<DiskCache>(&bytes)
      .ok()
      .filter(|c| c.version == CACHE_VERSION)
      .map(|c| c.entries)
      .unwrap_or_default(),
    Err(_) => Vec::new(),
  };
  let mut cache = lock(&hf.inner.checks);
  if cache.entries.is_none() {
    cache.entries = Some(entries);
  }
}

async fn cached(hf: &Hf, key: &str) -> Option<FileCheck> {
  ensure_loaded(hf).await;
  let cache = lock(&hf.inner.checks);
  cache.entries.as_ref()?.iter().find(|e| e.key == key).map(|e| e.result.clone())
}

/// Ajoute un résultat au cache et réécrit le fichier (écriture dans un temporaire puis
/// renommage ; une écriture à la fois).
async fn store(hf: &Hf, key: String, result: FileCheck) {
  ensure_loaded(hf).await;
  let _writing = hf.inner.checks_write.lock().await;
  let json = {
    let mut cache = lock(&hf.inner.checks);
    let entries = cache.entries.get_or_insert_with(Vec::new);
    entries.retain(|e| e.key != key);
    entries.push(Stored { key, result });
    if entries.len() > MAX_ENTRIES {
      let excess = entries.len() - MAX_ENTRIES;
      entries.drain(..excess);
    }
    serde_json::to_vec(&serde_json::json!({ "version": CACHE_VERSION, "entries": entries }))
  };
  let Ok(json) = json else { return };
  let path = cache_path(hf);
  let tmp = path.with_extension("json.tmp");
  let written = async {
    tokio::fs::create_dir_all(&hf.inner.cache_dir).await?;
    tokio::fs::write(&tmp, &json).await?;
    tokio::fs::rename(&tmp, &path).await
  };
  if let Err(e) = written.await {
    log(&format!("cache des vérifications non enregistré : {e}"));
  }
}

fn recent(hf: &Hf, req: &str) -> Option<FileCheck> {
  let cache = lock(&hf.inner.checks);
  cache.recent.get(req).filter(|(at, _)| at.elapsed() < RECENT_TTL).map(|(_, r)| r.clone())
}

fn remember(hf: &Hf, req: String, result: &FileCheck) {
  let mut cache = lock(&hf.inner.checks);
  cache.recent.retain(|_, (at, _)| at.elapsed() < RECENT_TTL);
  cache.recent.insert(req, (Instant::now(), result.clone()));
}

fn file_name(path: &str) -> &str {
  path.rsplit('/').next().unwrap_or(path)
}

/// `meta` : dimensions du modèle, conservées seulement s'il est accepté.
fn verdict(reason: Option<String>, info: ModelInfo, meta: Option<ArchMeta>) -> FileCheck {
  let reason_none = reason.is_none();
  FileCheck {
    standalone: reason_none,
    reason,
    architecture: info.architecture,
    block_count: info.block_count,
    context_length: info.context_length,
    param_count: info.param_count,
    meta: if reason_none { meta } else { None },
  }
}

fn refused(reason: String) -> FileCheck {
  verdict(Some(reason), ModelInfo::default(), None)
}

fn too_large(name: &str) -> String {
  format!("« {name} » : en-tête GGUF trop volumineux (plus de 64 Mo) pour être vérifié avant le téléchargement.")
}

enum Remote {
  Header(Header),
  Invalid(String),
  TooLarge,
}

/// Lit l'en-tête d'un fichier distant de taille `size`, en commençant par `initial` octets.
async fn read_remote(
  client: &Client,
  token: Option<&str>,
  repo: &str,
  file: &str,
  size: u64,
  initial: u64,
  bytes_read: &mut u64,
) -> Result<Remote, String> {
  let url = api::resolve_url(repo, file)?;
  let limit = size.min(MAX_HEADER);
  let mut target = initial.min(limit);
  let mut buf: Vec<u8> = Vec::new();
  loop {
    let chunk = api::fetch_range(client, token, &url, buf.len() as u64, target).await?;
    *bytes_read += chunk.len() as u64;
    buf.extend_from_slice(&chunk);
    match gguf::parse_header(&buf, size) {
      Ok(h) => return Ok(Remote::Header(h)),
      Err(HeaderError::Invalid(e)) => return Ok(Remote::Invalid(e)),
      Err(HeaderError::Incomplete) if target < limit => target = target.saturating_mul(2).min(limit),
      Err(HeaderError::Incomplete) => return Ok(Remote::TooLarge),
    }
  }
}

/// Applique les règles du moteur à un modèle distant. Renvoie le verdict et s'il peut être mis
/// en cache (pas si les parties suivantes ont été déduites du nom : elles ne font pas partie de
/// la clé).
async fn evaluate(
  client: &Client,
  token: Option<&str>,
  repo: &str,
  files: &[String],
  infos: &HashMap<String, PathInfo>,
  bytes_read: &mut u64,
) -> Result<(FileCheck, bool), String> {
  let first = &files[0];
  let name = file_name(first);
  let size = infos.get(first).map(|i| i.size).ok_or(api::FILE_NOT_FOUND)?;
  let h = match read_remote(client, token, repo, first, size, FIRST_CHUNK, bytes_read).await? {
    Remote::Header(h) => h,
    Remote::Invalid(e) => return Ok((refused(gguf::invalid_message(name, &e)), true)),
    Remote::TooLarge => return Ok((refused(too_large(name)), true)),
  };
  let arch = match gguf::check_kind(name, &h) {
    Ok(a) => a,
    Err(reason) => return Ok((verdict(Some(reason), gguf::model_info(&h, &[]), None), true)),
  };

  // Modèle découpé : les tenseurs sont répartis entre les parties, chacune avec son en-tête.
  let count = h.split_count();
  let mut others = Vec::new();
  let mut cacheable = true;
  if count > 1 {
    let parts: Vec<String> = if files.len() as u64 == count {
      files[1..].to_vec()
    } else {
      cacheable = false;
      match names::split_info(first) {
        Some((prefix, 1, total)) if u64::from(total) == count => names::split_names(prefix, total).split_off(1),
        _ => return Ok((refused(gguf::split_name_message(name)), false)),
      }
    };
    let mut part_infos = infos.clone();
    let unknown: Vec<String> = parts.iter().filter(|p| !part_infos.contains_key(*p)).cloned().collect();
    if !unknown.is_empty() {
      part_infos.extend(api::paths_info(client, token, repo, &unknown).await?);
    }
    for part in &parts {
      let pname = file_name(part);
      let Some(pi) = part_infos.get(part) else {
        return Ok((refused(gguf::missing_part_message(name, pname)), cacheable));
      };
      match read_remote(client, token, repo, part, pi.size, PART_CHUNK, bytes_read).await? {
        Remote::Header(ph) => others.push(ph),
        Remote::Invalid(e) => return Ok((refused(gguf::invalid_message(pname, &e)), cacheable)),
        Remote::TooLarge => return Ok((refused(too_large(pname)), cacheable)),
      }
    }
  }
  let reason = gguf::check_tensors(name, &arch, &h, &others).err();
  Ok((verdict(reason, gguf::model_info(&h, &others), Some(gguf::arch_meta(&h))), cacheable))
}

/// Vérifie qu'un modèle du dépôt (`files` : ses parties) est un modèle de chat autonome. Erreur :
/// vérification impossible (réseau, accès, fichier absent).
pub(super) async fn check(hf: &Hf, repo: &str, files: &[String]) -> Result<FileCheck, String> {
  if !names::valid_repo(repo) {
    return Err(format!("Dépôt invalide : « {repo} »"));
  }
  if files.is_empty() || files.len() > names::MAX_FILES {
    return Err(format!("Une vérification porte sur 1 à {} fichiers.", names::MAX_FILES));
  }
  if let Some(bad) = files.iter().find(|f| !names::valid_file(f)) {
    return Err(format!("Fichier invalide : « {bad} »"));
  }
  let mut files = files.to_vec();
  files.sort();
  files.dedup();
  let label = format!("{repo}/{}", files[0]);
  let req = format!("{repo}\n{}", files.join("\n"));
  if let Some(r) = recent(hf, &req) {
    return Ok(r);
  }

  let client = hf.client()?;
  let token = hf.token();
  let token = token.as_deref();
  let result = async {
    let infos = api::paths_info(&client, token, repo, &files).await?;
    let mut key = repo.to_string();
    for f in &files {
      let i = infos.get(f).ok_or(api::FILE_NOT_FOUND)?;
      key.push_str(&format!("\n{f}:{}:{}", i.oid, i.size));
    }
    if let Some(r) = cached(hf, &key).await {
      log(&format!("vérification de {label} : résultat en cache ({})", if r.standalone { "autonome" } else { "refusé" }));
      return Ok(r);
    }
    let mut bytes_read = 0;
    let started = Instant::now();
    let (r, cacheable) = evaluate(&client, token, repo, &files, &infos, &mut bytes_read).await?;
    let secs = started.elapsed().as_secs_f64();
    match &r.reason {
      None => log(&format!(
        "vérification de {label} : autonome ({}, {:?} couches), {bytes_read} octets lus en {secs:.1} s",
        r.architecture.as_deref().unwrap_or("?"),
        r.block_count.unwrap_or(0)
      )),
      Some(reason) => log(&format!("vérification de {label} : refusé, {bytes_read} octets lus en {secs:.1} s : {reason}")),
    }
    if cacheable {
      store(hf, key, r.clone()).await;
    }
    Ok::<_, String>(r)
  }
  .await;
  match &result {
    Ok(r) => remember(hf, req, r),
    Err(e) => log(&format!("vérification de {label} impossible : {e}")),
  }
  result
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Test réseau (ignoré par défaut) :
  ///   cargo test --lib hf::check -- --ignored --nocapture
  #[test]
  #[ignore]
  fn verification_reelle() {
    let root = std::env::temp_dir().join(format!("lucania-hf-check-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let hf = Hf::new(root.clone(), &root, "test", Box::new(|_| {}));
    tauri::async_runtime::block_on(async {
      let client = hf.client().unwrap();
      for (repo, file, standalone) in [
        ("JonathanColetti/Qwen3.8-27B-Uncensored-GGUF", "Qwen3.8-27B-Uncensored-draft-Q4_0.gguf", false),
        ("unsloth/Qwen3-4B-GGUF", "Qwen3-4B-Q4_K_M.gguf", true),
      ] {
        let files = vec![file.to_string()];
        let infos = api::paths_info(&client, None, repo, &files).await.expect("infos");
        let mut bytes = 0;
        let start = Instant::now();
        let (r, _) = evaluate(&client, None, repo, &files, &infos, &mut bytes).await.expect("vérification");
        eprintln!("{repo}/{file} : {bytes} octets lus en {:?}\n  {r:?}", start.elapsed());
        assert_eq!(r.standalone, standalone, "{r:?}");
        // Deuxième appel : cache récent, aucune lecture.
        let a = check(&hf, repo, &files).await.unwrap();
        assert_eq!(a, r);
        lock(&hf.inner.checks).recent.clear();
        let b = check(&hf, repo, &files).await.unwrap();
        assert_eq!(b, r);
      }
      // Cache disque relu par une nouvelle instance.
      let hf2 = Hf::new(root.clone(), &root, "test", Box::new(|_| {}));
      let files = vec!["Qwen3-4B-Q4_K_M.gguf".to_string()];
      assert!(check(&hf2, "unsloth/Qwen3-4B-GGUF", &files).await.unwrap().standalone);
      let disk = std::fs::read_to_string(root.join("hf-cache").join(CACHE_FILE)).unwrap();
      assert!(disk.contains("Qwen3-4B-Q4_K_M.gguf"));

      // Modèle découpé : en-tête de chaque partie.
      let repo = "ggml-org/models-moved";
      let models = hf.list_files(repo.into()).await.expect("fichiers");
      let split = models.iter().find(|m| m.files.len() == 3 && m.name == "stories15M-q8_0").expect("modèle découpé");
      let infos = api::paths_info(&client, None, repo, &split.files).await.expect("infos");
      let mut bytes = 0;
      let (r, cacheable) = evaluate(&client, None, repo, &split.files, &infos, &mut bytes).await.expect("vérification");
      eprintln!("{repo} découpé {:?} : {bytes} octets lus\n  {r:?}", split.files);
      assert!(r.standalone && cacheable, "{r:?}");
      // Première partie seule : parties suivantes déduites du nom (résultat non mis en cache).
      let first = vec![split.files[0].clone()];
      let (r1, cacheable) = evaluate(&client, None, repo, &first, &infos, &mut bytes).await.expect("vérification");
      assert_eq!(r1, r);
      assert!(!cacheable);
      // Téléchargement refusé avant tout fichier .part.
      let e = hf
        .download("JonathanColetti/Qwen3.8-27B-Uncensored-GGUF".into(), vec!["Qwen3.8-27B-Uncensored-draft-Q4_0.gguf".into()])
        .await
        .unwrap_err();
      eprintln!("téléchargement refusé : {e}");
      assert!(e.contains("tête MTP"));
      assert!(!root.join("JonathanColetti").exists());
      assert!(check(&hf, "unsloth/Qwen3-4B-GGUF", &["absent.gguf".into()]).await.is_err());
    });
    let _ = std::fs::remove_dir_all(&root);
  }
}
