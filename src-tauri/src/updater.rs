//! Mise à jour de l'app : compare la version installée à la dernière release GitHub, puis
//! télécharge et lance `Lucania-Update.exe` (l'installateur ferme l'app et remplace les fichiers).

use std::time::Duration;

use reqwest::{redirect::Policy, Client, Url};
use serde::{Deserialize, Serialize};

const LATEST_API: &str = "https://api.github.com/repos/Pierre-ML/Lucania/releases/latest";
const UPDATER_URL: &str = "https://github.com/Pierre-ML/Lucania/releases/latest/download/Lucania-Update.exe";
const UPDATER_FILE: &str = "Lucania-Update.exe";

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
/// puis ferme l'app. Refusé en dev : il n'y a pas d'installation à mettre à jour.
#[tauri::command]
pub async fn app_install_update(app: tauri::AppHandle) -> Result<(), String> {
  if cfg!(debug_assertions) {
    return Err("Mise à jour indisponible en mode développement.".into());
  }
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
  let bytes = resp.bytes().await.map_err(|e| format!("Téléchargement de la mise à jour interrompu : {e}"))?;
  // Un exe Windows commence toujours par « MZ » : écarte une page d'erreur servie à la place.
  if bytes.len() < 1024 || !bytes.starts_with(b"MZ") {
    return Err("Fichier de mise à jour invalide.".into());
  }
  let path = std::env::temp_dir().join(UPDATER_FILE);
  tokio::fs::write(&path, &bytes).await.map_err(|e| format!("Écriture de la mise à jour impossible : {e}"))?;

  // L'app se ferme d'abord ; l'installateur n'est lancé qu'après un court délai (via cmd, détaché),
  // pour qu'aucun fichier ne soit encore utilisé au moment du remplacement.
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("cmd.exe");
    cmd.raw_arg(format!("/C ping -n 4 127.0.0.1 >nul & start \"\" \"{}\"", path.display()));
    cmd.creation_flags(0x0000_0008 | 0x0800_0000); // DETACHED_PROCESS | CREATE_NO_WINDOW
    cmd.spawn().map_err(|e| format!("Lancement de la mise à jour impossible : {e}"))?;
  }
  #[cfg(not(windows))]
  std::process::Command::new(&path)
    .spawn()
    .map_err(|e| format!("Lancement de la mise à jour impossible : {e}"))?;

  std::thread::spawn(move || {
    std::thread::sleep(Duration::from_millis(300));
    app.exit(0);
  });
  Ok(())
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
  fn hotes_autorises() {
    assert!(allowed_host(&Url::parse("https://objects.githubusercontent.com/x").unwrap()));
    assert!(allowed_host(&Url::parse("https://github.com/Pierre-ML/Lucania").unwrap()));
    assert!(!allowed_host(&Url::parse("http://github.com/").unwrap()));
    assert!(!allowed_host(&Url::parse("https://evil.example/").unwrap()));
  }
}
