//! Mise à jour de l'app : compare la version installée à la dernière release GitHub, puis
//! télécharge et lance `Lucania-Update.exe` (l'installateur ferme l'app et remplace les fichiers).
//!
//! - `app_check_update` : interroge l'API GitHub (release la plus récente).
//! - `app_install_update` : téléchargement en flux (300 Mo maximum) avec l'événement
//!   `app-update-progress` (`{ downloaded, total }`, au plus ~10 par seconde, puis un dernier à 100 %),
//!   contrôle « MZ », écriture dans le dossier temporaire, puis, dans cet ordre :
//!   1. arrêt des processus enfants : génération arrêtée et modèle déchargé (au plus 5 s), puis
//!      serveur `node.exe` tué ET attendu (`kill` + `wait`) : plus rien ne verrouille l'installation ;
//!   2. lancement DIRECT de l'updater (exe graphique NSIS, aucune console, aucun `cmd`/`ping`) avec
//!      l'argument `/LUCANIA_WAITPID=<pid de l'app>` : son `.onInit` attend (invisible, 15 s au plus)
//!      la fin de ce processus avant de copier les fichiers ;
//!   3. `app.exit(0)` après 300 ms (le temps de répondre à la page). Filet : si la sortie normale
//!      n'a pas abouti 10 s plus tard, le processus se termine lui-même (`TerminateProcess`).
//!   Si l'updater ne peut pas être lancé, le serveur node est relancé et l'app continue.
//! - L'updater relance lui-même la nouvelle version, une seule fois, à la fin de la copie.
//! - Une garde atomique (`INSTALLING`) rend impossible un second lancement : tout appel pendant
//!   qu'une installation est en cours est refusé. La garde n'est relâchée qu'en cas d'échec avant le
//!   lancement ; une fois l'installateur lancé, l'app se ferme.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::{redirect::Policy, Client, Url};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

const LATEST_API: &str = "https://api.github.com/repos/Pierre-ML/Lucania/releases/latest";
const UPDATER_URL: &str = "https://github.com/Pierre-ML/Lucania/releases/latest/download/Lucania-Update.exe";
const UPDATER_FILE: &str = "Lucania-Update.exe";
/// Taille maximale acceptée pour l'exe de mise à jour.
const MAX_BYTES: u64 = 300 * 1024 * 1024;
const PROGRESS_EVENT: &str = "app-update-progress";
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
/// Argument lu par le `.onInit` de l'updater (src-tauri/windows/installer.nsi) : PID à attendre.
const WAIT_PID_ARG: &str = "/LUCANIA_WAITPID=";
/// Attente maximale de l'arrêt du moteur (génération en cours, déchargement du modèle).
const ENGINE_STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// Délai avant `app.exit(0)` (réponse à la page), puis délai du filet de terminaison forcée.
const EXIT_DELAY: Duration = Duration::from_millis(300);
const EXIT_FALLBACK: Duration = Duration::from_secs(10);

/// Vrai dès qu'une installation de mise à jour est en cours (téléchargement ou lancement).
static INSTALLING: AtomicBool = AtomicBool::new(false);

/// Prend la garde ; `None` si une installation est déjà en cours. Relâchée au `Drop`, sauf après `keep()`.
struct InstallGuard<'a> {
  flag: &'a AtomicBool,
  release: bool,
}

impl<'a> InstallGuard<'a> {
  fn acquire(flag: &'a AtomicBool) -> Option<Self> {
    flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok()?;
    Some(Self { flag, release: true })
  }

  /// L'installateur est lancé : la garde reste prise jusqu'à la fermeture de l'app.
  fn keep(mut self) {
    self.release = false;
  }
}

impl Drop for InstallGuard<'_> {
  fn drop(&mut self) {
    if self.release {
      self.flag.store(false, Ordering::SeqCst);
    }
  }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
  downloaded: u64,
  total: Option<u64>,
}

/// Hôtes autorisés : l'API GitHub et le stockage des fichiers de release (redirections).
fn allowed_host(url: &Url) -> bool {
  url.scheme() == "https"
    && url.host_str().is_some_and(|h| {
      let h = h.to_ascii_lowercase();
      h == "github.com" || h == "api.github.com" || h.ends_with(".githubusercontent.com")
    })
}

fn build_client(version: &str) -> Result<Client, String> {
  Client::builder()
    .user_agent(format!("Lucania/{version}"))
    .https_only(true)
    .connect_timeout(Duration::from_secs(15))
    .read_timeout(Duration::from_secs(60))
    .redirect(Policy::custom(|attempt| {
      if attempt.previous().len() >= 10 {
        attempt.error("trop de redirections")
      } else if !allowed_host(attempt.url()) {
        attempt.error("redirection vers un hôte non autorisé")
      } else {
        attempt.follow()
      }
    }))
    .build()
    .map_err(|e| format!("Client HTTP indisponible : {e}"))
}

/// Version « X.Y.Z » (préfixe `v` toléré, suffixe `-beta` ignoré) ; `None` si illisible.
fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
  let core = s.trim().trim_start_matches(['v', 'V']).split(['-', '+']).next()?;
  let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
  let v = (parts.next()??, parts.next()??, parts.next().unwrap_or(Some(0))?);
  parts.next().is_none().then_some(v)
}

fn is_newer(latest: &str, current: &str) -> bool {
  matches!((parse_version(latest), parse_version(current)), (Some(l), Some(c)) if l > c)
}

#[derive(Deserialize)]
struct Release {
  tag_name: String,
  #[serde(default)]
  html_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
  pub current: String,
  pub latest: String,
  pub available: bool,
  pub url: String,
}

/// Interroge GitHub et indique si une version plus récente que celle installée est publiée.
#[tauri::command]
pub async fn app_check_update(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
  let current = app.package_info().version.to_string();
  let client = build_client(&current)?;
  let resp = client
    .get(LATEST_API)
    .header("Accept", "application/vnd.github+json")
    .send()
    .await
    .map_err(|_| "GitHub injoignable : vérifiez la connexion Internet.".to_string())?;
  if resp.status() == reqwest::StatusCode::NOT_FOUND {
    return Err("Aucune version publiée sur GitHub.".into());
  }
  if !resp.status().is_success() {
    return Err(format!("GitHub a répondu {}.", resp.status().as_u16()));
  }
  let release: Release = resp.json().await.map_err(|_| "Réponse GitHub illisible.".to_string())?;
  let latest = release.tag_name.trim().trim_start_matches(['v', 'V']).to_string();
  Ok(UpdateInfo { available: is_newer(&latest, &current), current, latest, url: release.html_url })
}

/// Télécharge l'exe de mise à jour dans le dossier temporaire, le lance (processus détaché)
/// puis ferme l'app. Refusé en dev : il n'y a pas d'installation à mettre à jour. Un seul appel à la
/// fois : un second appel pendant l'installation est refusé.
#[tauri::command]
pub async fn app_install_update(app: tauri::AppHandle) -> Result<(), String> {
  if cfg!(debug_assertions) {
    return Err("Mise à jour indisponible en mode développement.".into());
  }
  let guard = InstallGuard::acquire(&INSTALLING).ok_or_else(|| "Une mise à jour est déjà en cours.".to_string())?;

  let version = app.package_info().version.to_string();
  let client = build_client(&version)?;
  let resp = client
    .get(UPDATER_URL)
    .send()
    .await
    .map_err(|_| "Téléchargement de la mise à jour impossible : GitHub injoignable.".to_string())?;
  if !resp.status().is_success() {
    return Err(format!("Téléchargement de la mise à jour refusé (HTTP {}).", resp.status().as_u16()));
  }
  let total = resp.content_length().filter(|n| *n > 0);
  if total.is_some_and(|n| n > MAX_BYTES) {
    return Err("Fichier de mise à jour trop volumineux.".into());
  }

  let mut bytes: Vec<u8> = Vec::with_capacity(total.unwrap_or(0).min(MAX_BYTES) as usize);
  let mut stream = resp.bytes_stream();
  let mut last_emit = Instant::now() - PROGRESS_EVERY;
  while let Some(chunk) = stream.next().await {
    let chunk = chunk.map_err(|e| format!("Téléchargement de la mise à jour interrompu : {e}"))?;
    if bytes.len() as u64 + chunk.len() as u64 > MAX_BYTES {
      return Err("Fichier de mise à jour trop volumineux.".into());
    }
    bytes.extend_from_slice(&chunk);
    if last_emit.elapsed() >= PROGRESS_EVERY {
      last_emit = Instant::now();
      let _ = app.emit(PROGRESS_EVENT, Progress { downloaded: bytes.len() as u64, total });
    }
  }
  // Un exe Windows commence toujours par « MZ » : écarte une page d'erreur servie à la place.
  if bytes.len() < 1024 || !bytes.starts_with(b"MZ") {
    return Err("Fichier de mise à jour invalide.".into());
  }
  let size = bytes.len() as u64;
  let _ = app.emit(PROGRESS_EVENT, Progress { downloaded: size, total: Some(size) });

  let path = std::env::temp_dir().join(UPDATER_FILE);
  tokio::fs::write(&path, &bytes).await.map_err(|e| format!("Écriture de la mise à jour impossible : {e}"))?;
  drop(bytes);

  // Arrêts bloquants (moteur, node) : hors du runtime asynchrone.
  let handle = app.clone();
  tauri::async_runtime::spawn_blocking(move || stop_children_and_launch(&handle, &path))
    .await
    .map_err(|e| format!("Lancement de la mise à jour impossible : {e}"))??;

  // Lancé : la garde reste prise (aucun second lancement possible) jusqu'à la fermeture.
  guard.keep();
  std::thread::spawn(move || {
    std::thread::sleep(EXIT_DELAY);
    app.exit(0);
    // Sortie normale : le processus disparaît avant la fin de ce délai. Sinon (sortie bloquée),
    // il se termine lui-même pour que l'updater, qui attend sa fin, puisse copier les fichiers.
    std::thread::sleep(EXIT_FALLBACK);
    terminate_self();
  });
  Ok(())
}

/// Argument de l'updater : PID de l'app, dont il attend la fin avant de copier les fichiers.
fn wait_pid_arg(pid: u32) -> String {
  format!("{WAIT_PID_ARG}{pid}")
}

/// Ordre garanti : moteur arrêté, node tué et attendu, PUIS lancement direct de l'updater.
/// En cas d'échec du lancement, le serveur node est relancé (l'app reste utilisable).
fn stop_children_and_launch(app: &tauri::AppHandle, path: &std::path::Path) -> Result<(), String> {
  stop_engine(app);
  crate::stop_sidecar(app);

  let mut cmd = std::process::Command::new(path);
  cmd
    .arg(wait_pid_arg(std::process::id()))
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    // Exe graphique : aucune console n'est créée. DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP :
    // aucun lien avec l'app, qui va se fermer.
    cmd.creation_flags(0x0000_0008 | 0x0000_0200);
  }
  if let Err(e) = cmd.spawn() {
    crate::restart_sidecar(app);
    return Err(format!("Lancement de la mise à jour impossible : {e}"));
  }
  Ok(())
}

/// Arrête la génération en cours et décharge le modèle (au plus `ENGINE_STOP_TIMEOUT`) : la sortie
/// du processus ne se fait pas pendant un calcul de llama.cpp.
fn stop_engine(app: &tauri::AppHandle) {
  use tauri::Manager;
  let Some(engine) = app.try_state::<crate::engine::Engine>() else { return };
  let engine = engine.inner().clone();
  engine.stop(None);
  let (tx, rx) = std::sync::mpsc::channel();
  std::thread::spawn(move || {
    let _ = tx.send(engine.unload());
  });
  let _ = rx.recv_timeout(ENGINE_STOP_TIMEOUT);
}

/// Filet de sécurité : termine immédiatement le processus (sans destructeurs ni `atexit`).
fn terminate_self() -> ! {
  #[cfg(windows)]
  {
    #[link(name = "kernel32")]
    unsafe extern "system" {
      fn GetCurrentProcess() -> *mut std::ffi::c_void;
      fn TerminateProcess(process: *mut std::ffi::c_void, exit_code: u32) -> i32;
    }
    // SAFETY : pseudo-handle du processus courant, toujours valide.
    unsafe {
      TerminateProcess(GetCurrentProcess(), 0);
    }
  }
  std::process::exit(0)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn lecture_de_version() {
    assert_eq!(parse_version("v0.2.0"), Some((0, 2, 0)));
    assert_eq!(parse_version("1.10.3-beta"), Some((1, 10, 3)));
    assert_eq!(parse_version("2.1"), Some((2, 1, 0)));
    assert_eq!(parse_version("abc"), None);
    assert_eq!(parse_version("1.2.3.4"), None);
  }

  #[test]
  fn comparaison_de_version() {
    assert!(is_newer("0.2.1", "0.2.0"));
    assert!(is_newer("v0.10.0", "0.9.9"));
    assert!(!is_newer("0.2.0", "0.2.0"));
    assert!(!is_newer("0.1.16", "0.2.0"));
    assert!(!is_newer("illisible", "0.2.0"));
  }

  #[test]
  fn garde_d_installation_unique() {
    let flag = AtomicBool::new(false);
    let first = InstallGuard::acquire(&flag).expect("première prise");
    assert!(InstallGuard::acquire(&flag).is_none());
    drop(first); // échec avant lancement : garde relâchée
    let again = InstallGuard::acquire(&flag).expect("reprise après échec");
    again.keep(); // installateur lancé : garde conservée
    assert!(InstallGuard::acquire(&flag).is_none());
  }

  #[test]
  fn argument_d_attente_de_l_updater() {
    // Contrat avec le .onInit de src-tauri/windows/installer.nsi (GetOptions "/LUCANIA_WAITPID=")
    assert_eq!(wait_pid_arg(1234), "/LUCANIA_WAITPID=1234");
    assert!(!wait_pid_arg(7).contains(' '));
  }

  #[test]
  fn hotes_autorises() {
    assert!(allowed_host(&Url::parse("https://objects.githubusercontent.com/x").unwrap()));
    assert!(allowed_host(&Url::parse("https://github.com/Pierre-ML/Lucania").unwrap()));
    assert!(!allowed_host(&Url::parse("http://github.com/").unwrap()));
    assert!(!allowed_host(&Url::parse("https://evil.example/").unwrap()));
  }
}
