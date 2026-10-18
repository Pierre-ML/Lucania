//! Commandes Tauri du catalogue Hugging Face. Arguments JS en camelCase, réponses JSON en
//! camelCase, erreurs en texte français. Tout tourne sur le runtime asynchrone : l'interface ne
//! gèle jamais.

use tauri::{AppHandle, Emitter, State};

use super::types::DownloadRemoved;
use std::collections::HashMap;

use super::{DownloadInfo, Event, EventSink, FileCheck, Hf, RepoModel, SearchResult, TokenStatus, log};

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

/// Vérifie l'en-tête du fichier sur Hugging Face, puis démarre le téléchargement (refusé, sans
/// rien écrire, si le fichier n'est pas un modèle de chat autonome).
#[tauri::command]
pub async fn hf_download(hf: State<'_, Hf>, repo: String, files: Vec<String>) -> Result<String, String> {
  let hf = hf.inner().clone();
  hf.download(repo, files).await
}

/// Vérification à distance de l'en-tête GGUF (sans téléchargement).
#[tauri::command]
pub async fn hf_check_file(hf: State<'_, Hf>, repo: String, files: Vec<String>) -> Result<FileCheck, String> {
  let hf = hf.inner().clone();
  hf.check_file(repo, files).await
}

/// Logos des auteurs ou organisations (30 noms au plus) : data URL ou null.
#[tauri::command]
pub async fn hf_avatars(hf: State<'_, Hf>, names: Vec<String>) -> Result<HashMap<String, Option<String>>, String> {
  let hf = hf.inner().clone();
  hf.avatars(names).await
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
