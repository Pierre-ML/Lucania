//! Commandes Tauri du moteur. Arguments JS en camelCase, réponses JSON en camelCase, erreurs en
//! texte français. Le travail bloquant part sur un thread du pool `spawn_blocking` : l'interface
//! ne gèle jamais.
//!
//! Une seule implémentation (`run`) sert les pages, l'API de la tour et le relais (`calls`).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Request;
use tauri::{AppHandle, Emitter};

use super::{ChatMessage, Engine, EstimateInput, Event, EventSink, GenParams, GenerateResult, LoadOptions, ModelProfile, log};
use crate::bus::{self, BusEvent};
use crate::calls::{self, CallError, parse, to_value};

pub const EVENT_TOKEN: &str = "engine://token";
pub const EVENT_STATUS: &str = "engine://status";

/// Relaie les événements du moteur local au bus interne et à toutes les fenêtres, y compris en
/// mode distant (le moteur de la tour a ses propres événements : `remote://engine-status`).
pub fn emitter(app: AppHandle) -> EventSink {
  Box::new(move |ev| {
    if bus::has_subscribers() {
      bus::publish(match &ev {
        Event::Token(t) => BusEvent::Token(t.clone()),
        Event::Status(s) => BusEvent::Status(s.clone()),
      });
    }
    let r = match ev {
      Event::Token(t) => app.emit(EVENT_TOKEN, t),
      Event::Status(s) => app.emit(EVENT_STATUS, s),
    };
    if let Err(e) = r {
      log(&format!("émission d'événement impossible : {e}"));
    }
  })
}

async fn blocking<T: Serialize + Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<Value, CallError> {
  let r = tauri::async_runtime::spawn_blocking(f)
    .await
    .map_err(|e| format!("Tâche du moteur interrompue : {e}"))??;
  to_value(r)
}

// Arguments des commandes (camelCase, comme les arguments de `invoke`).

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelArgs {
  model_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadArgs {
  model_id: String,
  options: Option<LoadOptions>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GenerateArgs {
  pub request_id: String,
  model_id: String,
  messages: Vec<ChatMessage>,
  params: Option<GenParams>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopArgs {
  request_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileArgs {
  model_id: String,
  profile: ModelProfile,
}

#[derive(Deserialize)]
struct EstimateArgs {
  input: EstimateInput,
}

/// Exécute localement une commande du moteur.
pub(crate) async fn run(engine: &Engine, name: &str, args: Value) -> Result<Value, CallError> {
  let e = engine.clone();
  match name {
    "engine_info" => blocking(move || Ok(e.info())).await,
    "engine_list_models" => blocking(move || e.list_models()).await,
    "engine_status" => to_value(e.status()),
    "engine_load" => {
      let a: LoadArgs = parse(name, args)?;
      blocking(move || e.load(a.model_id, a.options)).await
    }
    "engine_unload" => blocking(move || e.unload()).await,
    "engine_generate" => {
      let a: GenerateArgs = parse(name, args)?;
      to_value(generate(e, a).await?)
    }
    "engine_stop" => {
      let a: StopArgs = parse(name, args)?;
      e.stop(a.request_id.as_deref());
      to_value(())
    }
    "engine_delete_model" => {
      let a: ModelArgs = parse(name, args)?;
      blocking(move || e.delete_model(&a.model_id)).await
    }
    "engine_get_profile" => {
      let a: ModelArgs = parse(name, args)?;
      blocking(move || e.get_profile(a.model_id)).await
    }
    // Enregistre le profil ; ne recharge pas le modèle (la page appelle `engine_load` ensuite).
    "engine_set_profile" => {
      let a: ProfileArgs = parse(name, args)?;
      blocking(move || e.set_profile(a.model_id, a.profile)).await
    }
    "engine_reset_profile" => {
      let a: ModelArgs = parse(name, args)?;
      blocking(move || e.reset_profile(a.model_id)).await
    }
    "engine_estimate" => {
      let a: EstimateArgs = parse(name, args)?;
      blocking(move || e.estimate(a.input)).await
    }
    _ => Err(CallError::not_found(name)),
  }
}

/// Génération locale (jetons émis au fil de l'eau par l'`emitter`).
pub(crate) async fn generate(engine: Engine, a: GenerateArgs) -> Result<GenerateResult, String> {
  tauri::async_runtime::spawn_blocking(move || engine.generate(a.request_id, a.model_id, a.messages, a.params))
    .await
    .map_err(|e| format!("Tâche du moteur interrompue : {e}"))?
}

// Commandes Tauri : arguments bruts de `invoke`, relayés vers la tour en mode distant.

#[tauri::command]
pub async fn engine_info(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "engine_info", &request).await
}

#[tauri::command]
pub async fn engine_list_models(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "engine_list_models", &request).await
}

#[tauri::command]
pub async fn engine_status(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "engine_status", &request).await
}

#[tauri::command]
pub async fn engine_load(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "engine_load", &request).await
}

#[tauri::command]
pub async fn engine_unload(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "engine_unload", &request).await
}

#[tauri::command]
pub async fn engine_generate(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "engine_generate", &request).await
}

#[tauri::command]
pub async fn engine_delete_model(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "engine_delete_model", &request).await
}

#[tauri::command]
pub async fn engine_stop(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "engine_stop", &request).await
}

#[tauri::command]
pub async fn engine_get_profile(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "engine_get_profile", &request).await
}

#[tauri::command]
pub async fn engine_set_profile(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "engine_set_profile", &request).await
}

#[tauri::command]
pub async fn engine_reset_profile(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "engine_reset_profile", &request).await
}

#[tauri::command]
pub async fn engine_estimate(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  calls::invoke(&app, "engine_estimate", &request).await
}
