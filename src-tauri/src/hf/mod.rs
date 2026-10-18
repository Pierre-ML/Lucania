//! Catalogue Hugging Face : recherche de dépôts GGUF, fichiers d'un dépôt, téléchargements vers
//! le dossier des modèles (pause, reprise, annulation) et jeton d'accès.
//!
//! - `api` : appels HTTP (seul hôte appelé : huggingface.co, redirections vers son CDN) ;
//! - `download` : tâche de téléchargement (fichier `.part`, reprise par Range) ;
//! - `names` : validation des entrées et noms de fichiers GGUF (fonctions pures) ;
//! - `types` : structures échangées avec les pages ;
//! - `commands` : commandes Tauri.
//!
//! `Hf` est la poignée partagée (clonable) gérée par Tauri. Les téléchargements tournent sur le
//! runtime tokio de Tauri ; un verrou par téléchargement garantit qu'une seule tâche écrit dans
//! ses fichiers (une reprise attend la fin de la tâche mise en pause).

pub mod commands;
mod api;
mod download;
mod names;
mod types;

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use reqwest::Client;
use tauri::Manager;
use tokio::sync::Notify;

pub use types::{DownloadInfo, DownloadState, RepoModel, SearchResult, TokenStatus};

/// Événements relayés aux pages par `commands::emitter`.
pub enum Event {
  Download(DownloadInfo),
  Removed(String),
}

pub type EventSink = Box<dyn Fn(Event) + Send + Sync>;

/// Journal (stderr). Le jeton n'y figure jamais.
pub(crate) fn log(msg: &str) {
  eprintln!("[hf] {msg}");
}

/// Verrou tolérant : un thread qui a paniqué ne bloque pas les suivants.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
  m.lock().unwrap_or_else(|e| e.into_inner())
}

const NOT_FOUND: &str = "Téléchargement introuvable.";

struct Entry {
  info: DownloadInfo,
  /// Numéro de la tâche en cours : incrémenté à chaque démarrage et à chaque pause, une tâche
  /// dont le numéro n'est plus le bon s'arrête sans toucher à l'état.
  run: u64,
  /// Réveille la tâche pour qu'elle constate une pause ou une annulation.
  wake: Arc<Notify>,
}

struct Inner {
  client: Result<Client, String>,
  models_dir: PathBuf,
  token_file: PathBuf,
  user_file: PathBuf,
  token: Mutex<Option<String>>,
  user: Mutex<Option<String>>,
  downloads: Mutex<Vec<Entry>>,
  /// Verrou d'écriture par identifiant de téléchargement (conservé après annulation, pour
  /// qu'un nouveau téléchargement attende la fin du nettoyage).
  file_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
  sink: EventSink,
}

#[derive(Clone)]
pub struct Hf {
  inner: Arc<Inner>,
}

fn read_trimmed(path: &Path) -> Option<String> {
  std::fs::read_to_string(path).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn file_len(path: &Path) -> Option<u64> {
  std::fs::metadata(path).ok().filter(|m| m.is_file()).map(|m| m.len())
}

/// Supprime les dossiers devenus vides en remontant jusqu'à `root` (exclu).
pub(crate) fn remove_empty_dirs(root: &Path, from: Option<&Path>) {
  let mut dir = from;
  while let Some(d) = dir {
    if d == root || !d.starts_with(root) || std::fs::remove_dir(d).is_err() {
      break;
    }
    dir = d.parent();
  }
}

impl Hf {
  /// `models_dir` : dossier des modèles du moteur ; `data_dir` : dossier où ranger le jeton.
  pub fn new(models_dir: PathBuf, data_dir: &Path, version: &str, sink: EventSink) -> Hf {
    let client = api::build_client(version);
    if let Err(e) = &client {
      log(e);
    }
    let token_file = data_dir.join("hf-token");
    let user_file = data_dir.join("hf-user");
    let token = read_trimmed(&token_file);
    let user = token.as_ref().and_then(|_| read_trimmed(&user_file));
    let downloads = scan_parts(&models_dir);
    Hf {
      inner: Arc::new(Inner {
        client,
        models_dir,
        token_file,
        user_file,
        token: Mutex::new(token),
        user: Mutex::new(user),
        downloads: Mutex::new(downloads),
        file_locks: Mutex::new(HashMap::new()),
        sink,
      }),
    }
  }

  fn client(&self) -> Result<Client, String> {
    self.inner.client.clone()
  }

  fn token(&self) -> Option<String> {
    lock(&self.inner.token).clone()
  }

  fn models_dir(&self) -> &Path {
    &self.inner.models_dir
  }

  fn emit(&self, info: DownloadInfo) {
    (self.inner.sink)(Event::Download(info));
  }

  fn file_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
    lock(&self.inner.file_locks).entry(id.to_string()).or_default().clone()
  }

  /// Tous les fichiers sont présents (sans .part) dans le dossier des modèles.
  fn installed(&self, repo: &str, files: &[String]) -> bool {
    files
      .iter()
      .all(|f| names::dest_path(self.models_dir(), repo, f).is_ok_and(|p| p.is_file()))
  }

  // -------------------------------------------------------------------------------------------
  // Catalogue
  // -------------------------------------------------------------------------------------------

  pub async fn search(&self, query: Option<String>, limit: Option<u32>) -> Result<Vec<SearchResult>, String> {
    let query: String = query.unwrap_or_default().trim().chars().take(200).collect();
    let limit = limit.unwrap_or(30).clamp(1, 100);
    api::search(&self.client()?, self.token().as_deref(), &query, limit).await
  }

  pub async fn list_files(&self, repo: String) -> Result<Vec<RepoModel>, String> {
    if !names::valid_repo(&repo) {
      return Err(format!("Dépôt invalide : « {repo} »"));
    }
    let tree = api::list_tree(&self.client()?, self.token().as_deref(), &repo).await?;
    Ok(names::group_files(&tree)
      .into_iter()
      .map(|g| RepoModel {
        quant: names::quant(&g.name).or_else(|| names::quant(&g.files[0])),
        installed: self.installed(&repo, &g.files),
        name: g.name,
        files: g.files,
        size_bytes: g.size_bytes,
      })
      .collect())
  }

  // -------------------------------------------------------------------------------------------
  // Téléchargements
  // -------------------------------------------------------------------------------------------

  pub fn list_downloads(&self) -> Vec<DownloadInfo> {
    lock(&self.inner.downloads).iter().map(|e| e.info.clone()).collect()
  }

  /// Démarre un téléchargement, ou reprend un téléchargement connu (en pause ou en erreur).
  pub fn download(&self, repo: String, mut files: Vec<String>) -> Result<String, String> {
    if !names::valid_repo(&repo) {
      return Err(format!("Dépôt invalide : « {repo} »"));
    }
    if files.is_empty() || files.len() > names::MAX_FILES {
      return Err(format!("Un téléchargement compte de 1 à {} fichiers.", names::MAX_FILES));
    }
    if let Some(bad) = files.iter().find(|f| !names::valid_file(f)) {
      return Err(format!("Fichier invalide : « {bad} »"));
    }
    files.sort();
    files.dedup();
    for f in &files {
      names::dest_path(self.models_dir(), &repo, f)?;
    }
    let id = format!("{repo}/{}", files[0]);
    let installed = self.installed(&repo, &files);

    let snapshot = {
      let mut list = lock(&self.inner.downloads);
      let conflict = list.iter().any(|e| {
        e.info.id != id
          && e.info.repo == repo
          && e.info.state != DownloadState::Completed
          && e.info.files.iter().any(|f| files.contains(f))
      });
      if conflict {
        return Err("Un autre téléchargement utilise déjà ces fichiers.".into());
      }
      let index = match list.iter().position(|e| e.info.id == id) {
        Some(i) => {
          match list[i].info.state {
            DownloadState::Downloading => return Err("Ce téléchargement est déjà en cours.".into()),
            DownloadState::Completed if installed => return Err("Ce modèle est déjà installé.".into()),
            _ => {}
          }
          list[i].info.files = files;
          i
        }
        None => {
          if installed {
            return Err("Ce modèle est déjà installé.".into());
          }
          list.push(Entry {
            info: DownloadInfo {
              id: id.clone(),
              repo,
              model_id: id.clone(),
              files,
              state: DownloadState::Paused,
              downloaded_bytes: 0,
              total_bytes: None,
              speed_bps: 0,
              error: None,
            },
            run: 0,
            wake: Arc::new(Notify::new()),
          });
          list.len() - 1
        }
      };
      self.start(&mut list[index])
    };
    self.emit(snapshot);
    Ok(id)
  }

  /// Passe l'entrée à l'état « downloading » et lance sa tâche. Renvoie l'état à émettre.
  fn start(&self, entry: &mut Entry) -> DownloadInfo {
    entry.run += 1;
    entry.info.state = DownloadState::Downloading;
    entry.info.error = None;
    entry.info.speed_bps = 0;
    let task = download::run(
      self.clone(),
      entry.info.id.clone(),
      entry.info.repo.clone(),
      entry.info.files.clone(),
      entry.run,
      entry.wake.clone(),
    );
    tauri::async_runtime::spawn(task);
    entry.info.clone()
  }

  pub fn pause(&self, id: &str) -> Result<(), String> {
    let snapshot = {
      let mut list = lock(&self.inner.downloads);
      let e = list.iter_mut().find(|e| e.info.id == id).ok_or(NOT_FOUND)?;
      if e.info.state != DownloadState::Downloading {
        return Ok(());
      }
      e.run += 1;
      e.info.state = DownloadState::Paused;
      e.info.speed_bps = 0;
      e.wake.notify_one();
      e.info.clone()
    };
    self.emit(snapshot);
    Ok(())
  }

  pub fn resume(&self, id: &str) -> Result<(), String> {
    let snapshot = {
      let mut list = lock(&self.inner.downloads);
      let e = list.iter_mut().find(|e| e.info.id == id).ok_or(NOT_FOUND)?;
      if !matches!(e.info.state, DownloadState::Paused | DownloadState::Error) {
        return Ok(());
      }
      self.start(e)
    };
    self.emit(snapshot);
    Ok(())
  }

  /// Arrête le téléchargement, le retire de la liste et supprime ses fichiers partiels (sauf
  /// s'il était terminé : le modèle reste installé).
  pub async fn cancel(&self, id: &str) -> Result<(), String> {
    let entry = {
      let mut list = lock(&self.inner.downloads);
      let i = list.iter().position(|e| e.info.id == id).ok_or(NOT_FOUND)?;
      list.remove(i)
    };
    entry.wake.notify_one();
    (self.inner.sink)(Event::Removed(id.to_string()));
    if entry.info.state == DownloadState::Completed {
      return Ok(());
    }
    // Attend que la tâche ait lâché ses fichiers (Windows refuse de supprimer un fichier ouvert).
    let file_lock = self.file_lock(id);
    let _guard = file_lock.lock().await;
    let dir = self.models_dir().to_path_buf();
    let (repo, files) = (entry.info.repo, entry.info.files);
    tauri::async_runtime::spawn_blocking(move || cleanup(&dir, &repo, &files))
      .await
      .map_err(|e| format!("Nettoyage interrompu : {e}"))
  }

  /// Vrai si la tâche `run` est toujours celle du téléchargement `id`.
  fn is_current(&self, id: &str, run: u64) -> bool {
    lock(&self.inner.downloads).iter().any(|e| e.info.id == id && e.run == run)
  }

  /// Modifie l'entrée si la tâche `run` est toujours la sienne, puis émet son état.
  fn update(&self, id: &str, run: u64, f: impl FnOnce(&mut DownloadInfo)) {
    let snapshot = {
      let mut list = lock(&self.inner.downloads);
      let Some(e) = list.iter_mut().find(|e| e.info.id == id && e.run == run) else { return };
      f(&mut e.info);
      e.info.clone()
    };
    self.emit(snapshot);
  }

  // -------------------------------------------------------------------------------------------
  // Jeton
  // -------------------------------------------------------------------------------------------

  pub fn token_status(&self) -> TokenStatus {
    TokenStatus { has_token: lock(&self.inner.token).is_some(), user: lock(&self.inner.user).clone() }
  }

  /// Enregistre un jeton après l'avoir validé auprès de Hugging Face ; vide ou null : supprime
  /// le jeton enregistré.
  pub async fn set_token(&self, token: Option<String>) -> Result<TokenStatus, String> {
    let token = token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let Some(token) = token else {
      for f in [&self.inner.token_file, &self.inner.user_file] {
        match std::fs::remove_file(f) {
          Ok(()) => {}
          Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
          Err(e) => return Err(format!("Suppression du jeton impossible : {e}")),
        }
      }
      *lock(&self.inner.token) = None;
      *lock(&self.inner.user) = None;
      return Ok(self.token_status());
    };
    if token.len() > 512 || !token.bytes().all(|c| c.is_ascii_graphic()) {
      return Err("Jeton Hugging Face invalide.".into());
    }
    let user = api::whoami(&self.client()?, &token).await?;
    let (token_file, user_file) = (self.inner.token_file.clone(), self.inner.user_file.clone());
    let (t, u) = (token.clone(), user.clone());
    tauri::async_runtime::spawn_blocking(move || -> std::io::Result<()> {
      if let Some(dir) = token_file.parent() {
        std::fs::create_dir_all(dir)?;
      }
      std::fs::write(&token_file, t)?;
      std::fs::write(&user_file, u)
    })
    .await
    .map_err(|e| format!("Enregistrement du jeton interrompu : {e}"))?
    .map_err(|e| format!("Enregistrement du jeton impossible : {e}"))?;
    *lock(&self.inner.token) = Some(token);
    *lock(&self.inner.user) = Some(user.clone());
    Ok(TokenStatus { has_token: true, user: Some(user) })
  }
}

/// Supprime les .part d'un téléchargement annulé, les parties secondaires déjà terminées
/// (inutilisables sans la première), puis les dossiers devenus vides.
fn cleanup(models_dir: &Path, repo: &str, files: &[String]) {
  let dests: Vec<PathBuf> = files.iter().filter_map(|f| names::dest_path(models_dir, repo, f).ok()).collect();
  let first_installed = dests.first().is_some_and(|p| p.is_file());
  for (i, dest) in dests.iter().enumerate() {
    let _ = std::fs::remove_file(names::part_path(dest));
    if i > 0 && !first_installed {
      let _ = std::fs::remove_file(dest);
    }
  }
  for dest in &dests {
    remove_empty_dirs(models_dir, dest.parent());
  }
}

/// Téléchargements interrompus retrouvés au démarrage : chaque `.part` sous le dossier des
/// modèles donne un téléchargement en pause (taille totale inconnue jusqu'à la reprise).
fn scan_parts(models_dir: &Path) -> Vec<Entry> {
  let mut found: BTreeMap<String, (String, Vec<String>)> = BTreeMap::new();
  let mut stack = vec![(models_dir.to_path_buf(), String::new())];
  while let Some((dir, prefix)) = stack.pop() {
    let Ok(entries) = std::fs::read_dir(&dir) else { continue };
    for entry in entries.flatten() {
      let Ok(kind) = entry.file_type() else { continue };
      let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
      let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
      if kind.is_dir() {
        stack.push((entry.path(), rel));
      } else if kind.is_file() && name.ends_with(names::PART_EXT) {
        match names::deduce_from_part(&rel) {
          Some((repo, files)) => {
            found.entry(format!("{repo}/{}", files[0])).or_insert((repo, files));
          }
          None => log(&format!("fichier partiel non reconnu ignoré : {rel}")),
        }
      }
    }
  }
  found
    .into_iter()
    .map(|(id, (repo, files))| {
      let downloaded_bytes = files
        .iter()
        .filter_map(|f| names::dest_path(models_dir, &repo, f).ok())
        .map(|p| file_len(&p).or_else(|| file_len(&names::part_path(&p))).unwrap_or(0))
        .sum();
      Entry {
        info: DownloadInfo {
          model_id: id.clone(),
          id,
          repo,
          files,
          state: DownloadState::Paused,
          downloaded_bytes,
          total_bytes: None,
          speed_bps: 0,
          error: None,
        },
        run: 0,
        wake: Arc::new(Notify::new()),
      }
    })
    .collect()
}

/// Crée l'état `Hf` (appelé depuis `setup`, après `engine::setup`).
pub fn setup(app: &tauri::App, models_dir: PathBuf) {
  let data_dir = models_dir.parent().map(Path::to_path_buf).unwrap_or_else(|| models_dir.clone());
  let version = app.package_info().version.to_string();
  let hf = Hf::new(models_dir, &data_dir, &version, commands::emitter(app.handle().clone()));
  app.manage(hf);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reprise_apres_redemarrage() {
    let root = std::env::temp_dir().join(format!("lucania-hf-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let split = root.join("org/Big-GGUF/Q4");
    std::fs::create_dir_all(&split).unwrap();
    std::fs::create_dir_all(root.join("org/Small-GGUF")).unwrap();
    std::fs::write(root.join("org/Small-GGUF/s-Q8_0.gguf.part"), b"abc").unwrap();
    std::fs::write(split.join("b-00002-of-00002.gguf"), b"12345").unwrap();
    std::fs::write(split.join("b-00001-of-00002.gguf.part"), b"12").unwrap();
    std::fs::write(root.join("orphelin.gguf.part"), b"x").unwrap();

    let hf = Hf::new(root.clone(), &root, "test", Box::new(|_| {}));
    let list = hf.list_downloads();
    assert_eq!(list.len(), 2);
    let big = list.iter().find(|d| d.repo == "org/Big-GGUF").unwrap();
    assert_eq!(big.id, "org/Big-GGUF/Q4/b-00001-of-00002.gguf");
    assert_eq!(big.model_id, big.id);
    assert_eq!(big.files, ["Q4/b-00001-of-00002.gguf", "Q4/b-00002-of-00002.gguf"]);
    assert_eq!(big.downloaded_bytes, 7);
    assert_eq!(big.state, DownloadState::Paused);
    assert_eq!(big.total_bytes, None);
    let small = list.iter().find(|d| d.repo == "org/Small-GGUF").unwrap();
    assert_eq!(small.files, ["s-Q8_0.gguf"]);
    assert_eq!(small.downloaded_bytes, 3);

    // Annulation hors runtime : nettoyage direct.
    cleanup(&root, &big.repo, &big.files);
    assert!(!root.join("org/Big-GGUF").exists());
    assert!(root.join("org/Small-GGUF").exists());
    let _ = std::fs::remove_dir_all(&root);
  }

  /// Test réseau (ignoré par défaut) : téléchargement réel d'un petit modèle découpé avec pause,
  /// reprise, puis annulation d'un second téléchargement.
  ///   cargo test --lib hf::tests::telechargement_reel -- --ignored --nocapture
  #[test]
  #[ignore]
  fn telechargement_reel() {
    use std::time::{Duration, Instant};
    let root = std::env::temp_dir().join(format!("lucania-hf-dl-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let events = Arc::new(Mutex::new(Vec::<DownloadInfo>::new()));
    let ev = events.clone();
    let hf = Hf::new(
      root.clone(),
      &root,
      "test",
      Box::new(move |e| {
        if let Event::Download(d) = e {
          lock(&ev).push(d);
        }
      }),
    );
    let state = |hf: &Hf, id: &str| hf.list_downloads().into_iter().find(|d| d.id == id);
    tauri::async_runtime::block_on(async {
      let repo = "ggml-org/models-moved";
      let models = hf.list_files(repo.into()).await.expect("fichiers");
      let split = models.iter().find(|m| m.files.len() == 3 && m.name == "stories15M-q8_0").expect("modèle découpé");
      eprintln!("{} {:?} {} octets {:?}", split.name, split.files, split.size_bytes, split.quant);
      let id = hf.download(repo.into(), split.files.clone()).expect("démarrage");
      assert_eq!(id, format!("{repo}/{}", split.files[0]));
      assert!(hf.download(repo.into(), split.files.clone()).is_err(), "déjà en cours");

      let wait = |cond: &dyn Fn(&DownloadInfo) -> bool, secs: u64| {
        let deadline = Instant::now() + Duration::from_secs(secs);
        let (hf, id) = (hf.clone(), id.clone());
        loop {
          if state(&hf, &id).is_some_and(|d| cond(&d)) {
            break true;
          }
          if Instant::now() > deadline {
            break false;
          }
          std::thread::sleep(Duration::from_millis(20));
        }
      };
      assert!(wait(&|d| d.downloaded_bytes > 0 && d.total_bytes.is_some(), 60), "progression");
      hf.pause(&id).unwrap();
      tokio::time::sleep(Duration::from_millis(500)).await;
      let paused = state(&hf, &id).unwrap();
      eprintln!("en pause : {} / {:?}", paused.downloaded_bytes, paused.total_bytes);
      assert_eq!(paused.state, DownloadState::Paused);
      hf.resume(&id).unwrap();
      assert!(wait(&|d| d.state != DownloadState::Downloading, 180), "fin");
      let done = state(&hf, &id).unwrap();
      eprintln!("fin : {:?} {:?}", done.state, done.error);
      assert_eq!(done.state, DownloadState::Completed);
      assert_eq!(done.downloaded_bytes, split.size_bytes);
      for f in &split.files {
        let p = names::dest_path(&root, repo, f).unwrap();
        assert!(p.is_file() && !names::part_path(&p).exists(), "{f}");
      }
      assert!(hf.list_files(repo.into()).await.unwrap().iter().any(|m| m.files == split.files && m.installed));
      assert!(hf.download(repo.into(), split.files.clone()).is_err(), "déjà installé");
      let n = lock(&events).iter().filter(|d| d.id == id).count();
      eprintln!("{n} événements émis");

      // Annulation : plus de .part ni de dossier vide.
      let single = vec!["tinyllamas/stories260K-infill.gguf".to_string()];
      let id2 = hf.download(repo.into(), single.clone()).unwrap();
      hf.cancel(&id2).await.unwrap();
      assert!(state(&hf, &id2).is_none());
      let p = names::dest_path(&root, repo, &single[0]).unwrap();
      assert!(!names::part_path(&p).exists() && !p.exists());
    });
    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn validation_des_demandes() {
    let root = std::env::temp_dir().join(format!("lucania-hf-valid-{}", std::process::id()));
    let hf = Hf::new(root.clone(), &root, "test", Box::new(|_| {}));
    assert!(hf.download("pas-un-depot".into(), vec!["a.gguf".into()]).is_err());
    assert!(hf.download("a/b".into(), vec![]).is_err());
    assert!(hf.download("a/b".into(), vec!["../a.gguf".into()]).is_err());
    assert!(hf.download("a/b".into(), (0..11).map(|i| format!("{i}.gguf")).collect()).is_err());
    assert!(hf.pause("inconnu").is_err());
    assert!(hf.list_downloads().is_empty());
  }
}
