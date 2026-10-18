//! Commandes Tauri du catalogue Hugging Face. Arguments JS en camelCase, réponses JSON en
//! camelCase, erreurs en texte français. Tout tourne sur le runtime asynchrone : l'interface ne
//! gèle jamais.
//!
//! Une seule implémentation (`run`) sert les pages, l'API de la tour et le relais (`calls`) ;
//! `hf_avatars` reste toujours locale.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;
use tauri::ipc::Request;
use tauri::{AppHandle, Emitter, State};

use super::types::DownloadRemoved;
use super::{Event, EventSink, Hf, log};
use crate::bus::{self, BusEvent};
use crate::calls::{self, CallError, parse, to_value};

pub const EVENT_DOWNLOAD: &str = "hf://download";
pub const EVENT_REMOVED: &str = "hf://download-removed";

/// Relaie les événements des téléchargements au bus interne et à toutes les fenêtres (sauf en
/// mode distant : les pages suivent alors les téléchargements de la tour).
pub fn emitter(app: AppHandle) -> EventSink {
  Box::new(move |ev| {
    if bus::has_subscribers() {
      bus::publish(match &ev {
        Event::Download(info) => BusEvent::Download(info.clone()),
        Event::Removed(id) => BusEvent::Removed(id.clone()),
      });
    }
    if crate::remote::is_remote() {
      return;
    }
    let r = match ev {
      Event::Download(info) => app.emit(EVENT_DOWNLOAD, info),
      Event::Removed(id) => app.emit(EVENT_REMOVED, DownloadRemoved { id }),
    };
    if let Err(e) = r {
      log(&format!("émission d'événement impossible : {e}"));
    }
  })
}

// Arguments des commandes (camelCase, comme les arguments de `invoke`).

#[derive(Deserialize)]
struct SearchArgs {
  query: Option<String>,
  limit: Option<u32>,
}

#[derive(Deserialize)]
struct RepoArgs {
  repo: String,
}

#[derive(Deserialize)]
struct FilesArgs {
  repo: String,
  files: Vec<String>,
}

#[derive(Deserialize)]
struct IdArgs {
  id: String,
}

#[derive(Deserialize)]
struct TokenArgs {
  token: Option<String>,
}

/// Exécute localement une commande du catalogue.
pub(crate) async fn run(hf: &Hf, name: &str, args: Value) -> Result<Value, CallError> {
  match name {
    "hf_search" => {
      let a: SearchArgs = parse(name, args)?;
      to_value(hf.search(a.query, a.limit).await?)
    }
    "hf_list_files" => {
      let a: RepoArgs = parse(name, args)?;
      to_value(hf.list_files(a.repo).await?)
    }
    // Vérifie l'en-tête du fichier sur Hugging Face, puis démarre le téléchargement (refusé,
    // sans rien écrire, si le fichier n'est pas un modèle de chat autonome).
    "hf_download" => {
      let a: FilesArgs = parse(name, args)?;
      to_value(hf.download(a.repo, a.files).await?)
    }
    // Vérification à distance de l'en-tête GGUF (sans téléchargement).
    "hf_check_file" => {
      let a: FilesArgs = parse(name, args)?;
      to_value(hf.check_file(a.repo, a.files).await?)
    }
    "hf_pause" => {
      let a: IdArgs = parse(name, args)?;
      to_value(hf.pause(&a.id)?)
    }
    "hf_resume" => {
      let a: IdArgs = parse(name, args)?;
      to_value(hf.resume(&a.id)?)
    }
    "hf_cancel" => {
      let a: IdArgs = parse(name, args)?;
      to_value(hf.cancel(&a.id).await?)
    }
    "hf_list_downloads" => to_value(hf.list_downloads()),
    "hf_token_status" => to_value(hf.token_status()),
    "hf_set_token" => {
      let a: TokenArgs = parse(name, args)?;
      to_value(hf.set_token(a.token).await?)
    }
    _ => Err(CallError::not_found(name)),
  }
}

// Commandes Tauri : arguments bruts de `invoke`, relayés vers la tour en mode distant.

#[tauri::command]
pub async fn hf_search(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "hf_search", &request).await
}

#[tauri::command]
pub async fn hf_list_files(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "hf_list_files", &request).await
}

#[tauri::command]
pub async fn hf_download(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "hf_download", &request).await
}

#[tauri::command]
pub async fn hf_check_file(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "hf_check_file", &request).await
}

/// Logos des auteurs ou organisations (30 noms au plus) : data URL ou null. Toujours local.
#[tauri::command]
pub async fn hf_avatars(hf: State<'_, Hf>, names: Vec<String>) -> Result<HashMap<String, Option<String>>, String> {
  let hf = hf.inner().clone();
  hf.avatars(names).await
}

#[tauri::command]
pub async fn hf_pause(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "hf_pause", &request).await
}

#[tauri::command]
pub async fn hf_resume(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "hf_resume", &request).await
}

#[tauri::command]
pub async fn hf_cancel(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "hf_cancel", &request).await
}

#[tauri::command]
pub async fn hf_list_downloads(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "hf_list_downloads", &request).await
}

#[tauri::command]
pub async fn hf_token_status(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "hf_token_status", &request).await
}

#[tauri::command]
pub async fn hf_set_token(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "hf_set_token", &request).await
}
