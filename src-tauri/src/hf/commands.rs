//! Commandes Tauri du catalogue Hugging Face. Arguments JS en camelCase, réponses JSON en
//! camelCase, erreurs en texte français. Tout tourne sur le runtime asynchrone : l'interface ne
//! gèle jamais.

use tauri::{AppHandle, Emitter, State};

use super::types::DownloadRemoved;
use super::{DownloadInfo, Event, EventSink, Hf, RepoModel, SearchResult, TokenStatus, log};

pub const EVENT_DOWNLOAD: &str = "hf://download";
pub const EVENT_REMOVED: &str = "hf://download-removed";

/// Relaie les événements des téléchargements à toutes les fenêtres.
pub fn emitter(app: AppHandle) -> EventSink {
  Box::new(move |ev| {
    let r = match ev {
      Event::Download(info) => app.emit(EVENT_DOWNLOAD, info),
      Event::Removed(id) => app.emit(EVENT_REMOVED, DownloadRemoved { id }),
    };
    if let Err(e) = r {
      log(&format!("émission d'événement impossible : {e}"));
    }
  })
}

#[tauri::command]
pub async fn hf_search(hf: State<'_, Hf>, query: Option<String>, limit: Option<u32>) -> Result<Vec<SearchResult>, String> {
  hf.search(query, limit).await
}

#[tauri::command]
pub async fn hf_list_files(hf: State<'_, Hf>, repo: String) -> Result<Vec<RepoModel>, String> {
  hf.list_files(repo).await
}

#[tauri::command]
pub async fn hf_download(hf: State<'_, Hf>, repo: String, files: Vec<String>) -> Result<String, String> {
  hf.download(repo, files)
}

#[tauri::command]
pub async fn hf_pause(hf: State<'_, Hf>, id: String) -> Result<(), String> {
  hf.pause(&id)
}

#[tauri::command]
pub async fn hf_resume(hf: State<'_, Hf>, id: String) -> Result<(), String> {
  hf.resume(&id)
}

#[tauri::command]
pub async fn hf_cancel(hf: State<'_, Hf>, id: String) -> Result<(), String> {
  let hf = hf.inner().clone();
  hf.cancel(&id).await
}

#[tauri::command]
pub async fn hf_list_downloads(hf: State<'_, Hf>) -> Result<Vec<DownloadInfo>, String> {
  Ok(hf.list_downloads())
}

#[tauri::command]
pub async fn hf_token_status(hf: State<'_, Hf>) -> Result<TokenStatus, String> {
  Ok(hf.token_status())
}

#[tauri::command]
pub async fn hf_set_token(hf: State<'_, Hf>, token: Option<String>) -> Result<TokenStatus, String> {
  let hf = hf.inner().clone();
  hf.set_token(token).await
}
