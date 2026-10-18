//! Commandes Tauri du moteur. Arguments JS en camelCase, réponses JSON en camelCase, erreurs en
//! texte français. Le travail bloquant part sur un thread du pool `spawn_blocking` : l'interface
//! ne gèle jamais.

use tauri::{AppHandle, Emitter, State};

use super::{ChatMessage, Engine, EngineInfo, EngineStatus, Event, EventSink, GenParams, GenerateResult, LoadOptions, ModelEntry, log};

pub const EVENT_TOKEN: &str = "engine://token";
pub const EVENT_STATUS: &str = "engine://status";

/// Relaie les événements du moteur à toutes les fenêtres.
pub fn emitter(app: AppHandle) -> EventSink {
  Box::new(move |ev| {
    let r = match ev {
      Event::Token(t) => app.emit(EVENT_TOKEN, t),
      Event::Status(s) => app.emit(EVENT_STATUS, s),
    };
    if let Err(e) = r {
      log(&format!("émission d'événement impossible : {e}"));
    }
  })
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f)
    .await
    .map_err(|e| format!("Tâche du moteur interrompue : {e}"))?
}

#[tauri::command]
pub async fn engine_info(engine: State<'_, Engine>) -> Result<EngineInfo, String> {
  let e = engine.inner().clone();
  blocking(move || Ok(e.info())).await
}

#[tauri::command]
pub async fn engine_list_models(engine: State<'_, Engine>) -> Result<Vec<ModelEntry>, String> {
  let e = engine.inner().clone();
  blocking(move || e.list_models()).await
}

#[tauri::command]
pub async fn engine_status(engine: State<'_, Engine>) -> Result<EngineStatus, String> {
  Ok(engine.status())
}

#[tauri::command]
pub async fn engine_load(engine: State<'_, Engine>, model_id: String, options: Option<LoadOptions>) -> Result<(), String> {
  let e = engine.inner().clone();
  blocking(move || e.load(model_id, options)).await
}

#[tauri::command]
pub async fn engine_unload(engine: State<'_, Engine>) -> Result<(), String> {
  let e = engine.inner().clone();
  blocking(move || e.unload()).await
}

#[tauri::command]
pub async fn engine_generate(
  engine: State<'_, Engine>,
  request_id: String,
  model_id: String,
  messages: Vec<ChatMessage>,
  params: Option<GenParams>,
) -> Result<GenerateResult, String> {
  let e = engine.inner().clone();
  blocking(move || e.generate(request_id, model_id, messages, params)).await
}

#[tauri::command]
pub async fn engine_delete_model(engine: State<'_, Engine>, model_id: String) -> Result<(), String> {
  let e = engine.inner().clone();
  blocking(move || e.delete_model(&model_id)).await
}

#[tauri::command]
pub async fn engine_stop(engine: State<'_, Engine>, request_id: Option<String>) -> Result<(), String> {
  engine.stop(request_id.as_deref());
  Ok(())
}
