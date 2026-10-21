//! Point d'entrée unique des commandes partagées entre les pages, l'API de la tour et le relais.
//!
//! Chaque commande de la liste blanche reçoit les arguments JSON de `invoke` (camelCase) :
//! - appelée par une page : exécutée localement par défaut, même en mode distant ; relayée vers la
//!   tour seulement si les arguments portent `"target": "server"` (champ retiré avant exécution ;
//!   erreur « Aucune tour configurée. » si le mode distant n'est pas actif) ;
//! - appelée par la route `/api/v1/call/{commande}` : toujours exécutée localement (pas de
//!   relais en cascade).

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};

use crate::engine::Engine;
use crate::hf::Hf;

/// Commandes appelables à distance par `/api/v1/call/{commande}` (et donc relayées).
/// `engine_generate` a sa propre route (`/api/v1/generate`, flux SSE).
pub const RELAYED: [&str; 22] = [
  "engine_info",
  "engine_list_models",
  "engine_status",
  "engine_load",
  "engine_unload",
  "engine_stop",
  "engine_delete_model",
  "engine_get_profile",
  "engine_set_profile",
  "engine_reset_profile",
  "engine_estimate",
  "hf_search",
  "hf_list_files",
  "hf_download",
  "hf_pause",
  "hf_resume",
  "hf_cancel",
  "hf_list_downloads",
  "hf_check_file",
  "hf_token_status",
  "hf_set_token",
  "system_hardware",
];

pub fn is_relayed(name: &str) -> bool {
  RELAYED.contains(&name)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
  /// Arguments illisibles ou incomplets (HTTP 400).
  BadArgs,
  /// Commande inconnue (HTTP 404).
  NotFound,
  /// La commande a échoué (HTTP 422).
  Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallError {
  pub kind: ErrorKind,
  pub message: String,
}

impl CallError {
  pub fn not_found(name: &str) -> Self {
    CallError { kind: ErrorKind::NotFound, message: format!("Commande inconnue : {name}") }
  }

  pub fn status(&self) -> u16 {
    match self.kind {
      ErrorKind::BadArgs => 400,
      ErrorKind::NotFound => 404,
      ErrorKind::Failed => 422,
    }
  }
}

impl From<String> for CallError {
  fn from(message: String) -> Self {
    CallError { kind: ErrorKind::Failed, message }
  }
}

/// Lit les arguments d'une commande (objet JSON camelCase ; absent = objet vide).
pub fn parse<T: DeserializeOwned>(name: &str, args: Value) -> Result<T, CallError> {
  let args = if args.is_null() { Value::Object(Default::default()) } else { args };
  serde_json::from_value(args)
    .map_err(|e| CallError { kind: ErrorKind::BadArgs, message: format!("Arguments invalides pour {name} : {e}") })
}

/// Réponse d'une commande en JSON.
pub fn to_value<T: Serialize>(v: T) -> Result<Value, CallError> {
  serde_json::to_value(v).map_err(|e| CallError::from(format!("Réponse illisible : {e}")))
}

/// Arguments JSON bruts d'un appel `invoke` (tels qu'envoyés par la page).
pub fn args(request: &Request<'_>) -> Result<Value, String> {
  match request.body() {
    InvokeBody::Json(v) => Ok(v.clone()),
    InvokeBody::Raw(_) => Err("Arguments invalides : JSON attendu.".into()),
  }
}

/// Exécute une commande sur cette machine (jamais relayée).
pub async fn local(app: &AppHandle, name: &str, args: Value) -> Result<Value, CallError> {
  if name.starts_with("engine_") {
    let engine = app
      .try_state::<Engine>()
      .map(|e| e.inner().clone())
      .ok_or_else(|| CallError::from("Moteur indisponible.".to_string()))?;
    crate::engine::commands::run(&engine, name, args).await
  } else if name.starts_with("hf_") {
    let hf = app
      .try_state::<Hf>()
      .map(|h| h.inner().clone())
      .ok_or_else(|| CallError::from("Catalogue Hugging Face indisponible.".to_string()))?;
    crate::hf::commands::run(&hf, name, args).await
  } else if name == "system_hardware" {
    crate::hardware::run(app).await
  } else {
    Err(CallError::not_found(name))
  }
}

/// Retire le champ `target` des arguments (objet JSON) ; vrai s'il valait `"server"`.
/// Arguments absents, non objet, ou `target` d'une autre valeur : faux (exécution locale).
pub fn take_target(args: &mut Value) -> bool {
  args.as_object_mut().and_then(|o| o.remove("target")).is_some_and(|t| t.as_str() == Some("server"))
}

/// Commande appelée par une page : locale par défaut (même en mode distant) ; relayée vers la
/// tour seulement si les arguments portent `"target": "server"`.
pub async fn invoke(app: &AppHandle, name: &str, request: &Request<'_>) -> Result<Value, String> {
  let mut args = args(request)?;
  if take_target(&mut args) {
    let relayable = name == "engine_generate" || is_relayed(name);
    if !relayable {
      return Err(CallError::not_found(name).message);
    }
    let remote = crate::remote::active(app).ok_or_else(|| "Aucune tour configurée.".to_string())?;
    return if name == "engine_generate" { remote.generate(app, args).await } else { remote.call(name, args).await };
  }
  local(app, name, args).await.map_err(|e| e.message)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn liste_blanche() {
    assert!(is_relayed("engine_load"));
    assert!(is_relayed("system_hardware"));
    assert!(is_relayed("hf_set_token"));
    for local_only in ["engine_generate", "hf_avatars", "app_crash_logs", "uninstall_app", "app_check_update", "app_install_update", "server_start", "server_interfaces", "server_delete", "server_get_shutdown", "server_set_shutdown", "remote_shutdown_info", "server_generate_key", "remote_discover", "remote_set_config", ""] {
      assert!(!is_relayed(local_only), "{local_only}");
    }
    // Pas de doublon.
    let mut sorted = RELAYED.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), RELAYED.len());
  }

  #[test]
  fn cible_du_relais() {
    let mut a = serde_json::json!({ "modelId": "m", "target": "server" });
    assert!(take_target(&mut a));
    assert_eq!(a, serde_json::json!({ "modelId": "m" }));
    for (mut a, rest) in [
      (serde_json::json!({ "target": "local", "x": 1 }), serde_json::json!({ "x": 1 })),
      (serde_json::json!({ "target": 1 }), serde_json::json!({})),
      (serde_json::json!({ "target": null }), serde_json::json!({})),
      (serde_json::json!({ "x": 1 }), serde_json::json!({ "x": 1 })),
      (Value::Null, Value::Null),
      (serde_json::json!("server"), serde_json::json!("server")),
    ] {
      assert!(!take_target(&mut a));
      assert_eq!(a, rest);
    }
  }

  #[test]
  fn arguments() {
    #[derive(serde::Deserialize, Debug)]
    #[serde(rename_all = "camelCase")]
    struct A {
      model_id: String,
      opt: Option<u32>,
    }
    let a: A = parse("x", serde_json::json!({ "modelId": "m", "extra": 1 })).unwrap();
    assert_eq!((a.model_id.as_str(), a.opt), ("m", None));
    let e = parse::<A>("engine_load", Value::Null).unwrap_err();
    assert_eq!(e.kind, ErrorKind::BadArgs);
    assert!(e.message.starts_with("Arguments invalides pour engine_load"));
    assert_eq!(CallError::not_found("x").status(), 404);
  }
}
