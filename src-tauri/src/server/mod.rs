//! Mode serveur (la « tour ») : API HTTP dans le processus Tauri, exposant le moteur et le
//! catalogue Hugging Face à un autre poste (portable, à travers un tunnel WireGuard).
//!
//! - `auth` : clé d'API (empreinte SHA-256 seule enregistrée) et limite de débit ;
//! - `discovery` : découverte de la tour sur le réseau local (UDP) ;
//! - `net` : interfaces IPv4 et validation de l'adresse d'écoute ;
//! - `http` : routeur axum (routes `/api/v1/*`).
//!
//! Configuration : `<app_local_data_dir>/server.json` (`bindIp`, `port`, `allowAll`, `active`,
//! `keyHash`, `key`). La clé en clair est conservée pour pouvoir être ré-affichée (l'empreinte
//! reste la seule référence pour authentifier). Serveur actif au lancement de l'app : relancé avec la configuration enregistrée.

pub mod auth;
pub mod discovery;
pub mod http;
pub mod net;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::watch;

use crate::calls::{self, CallError};
use crate::engine::{Engine, EngineStatus};
use auth::{KeyHash, Limiter};
use http::{Backend, HttpState};
use net::NetInterface;

pub const EVENT_STATE: &str = "server://state";

/// Arrêt propre : au-delà, les connexions restantes sont coupées.
const STOP_GRACE: Duration = Duration::from_secs(3);
/// Au lancement de l'app, l'interface WireGuard peut apparaître un peu après : nouvel essai
/// toutes les 5 s pendant 60 s.
const RESUME_RETRY: Duration = Duration::from_secs(5);
const RESUME_FOR: Duration = Duration::from_secs(60);

/// Journal (stderr et journal de session). Ni la clé ni le contenu des messages n'y figurent.
pub(crate) fn log(msg: &str) {
  eprintln!("[serveur] {msg}");
  crate::crashlog::note(&format!("[serveur] {msg}"));
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
  m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Contenu de `server.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Saved {
  bind_ip: Option<String>,
  port: u16,
  allow_all: bool,
  active: bool,
  /// SHA-256 de la clé, en hexadécimal.
  key_hash: Option<String>,
  /// Clé en clair, pour la ré-afficher ; absente des anciens fichiers.
  key: Option<String>,
  /// Extinction à distance de la tour ; absente des anciens fichiers.
  shutdown: ShutdownInfo,
}

impl Default for Saved {
  fn default() -> Self {
    Saved { bind_ip: None, port: net::DEFAULT_PORT, allow_all: false, active: false, key_hash: None, key: None, shutdown: ShutdownInfo::default() }
  }
}

/// Façon d'éteindre la tour à distance (le jeton secret n'est ni stocké ni transmis).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShutdownInfo {
  pub enabled: bool,
  pub url: String,
  /// « GET » ou « POST ».
  pub method: String,
  pub token_required: bool,
}

impl Default for ShutdownInfo {
  fn default() -> Self {
    ShutdownInfo { enabled: false, url: String::new(), method: "GET".into(), token_required: false }
  }
}

impl ShutdownInfo {
  /// Valeur exposée par l'API : l'objet par défaut tant que l'extinction n'est pas activée.
  pub fn exposed(&self) -> ShutdownInfo {
    if self.enabled { self.clone() } else { ShutdownInfo::default() }
  }
}

/// Valide la configuration d'extinction saisie (activée : adresse http(s) et méthode GET/POST).
fn validate_shutdown(enabled: bool, url: &str, method: &str, token_required: bool) -> Result<ShutdownInfo, String> {
  let url = url.trim();
  let method_up = method.trim().to_ascii_uppercase();
  let method_ok = method_up == "GET" || method_up == "POST";
  if enabled {
    if url.is_empty() {
      return Err("Indiquez l'adresse d'extinction.".into());
    }
    let parsed = reqwest::Url::parse(url).map_err(|_| format!("Adresse d'extinction invalide : « {url} »."))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
      return Err("Adresse d'extinction invalide : elle doit commencer par http:// ou https://.".into());
    }
    if parsed.host_str().is_none_or(str::is_empty) {
      return Err(format!("Adresse d'extinction invalide : « {url} »."));
    }
    if !method_ok {
      return Err("Méthode d'extinction invalide : « GET » ou « POST » attendu.".into());
    }
  }
  let method = if method_ok { method_up } else { "GET".into() };
  Ok(ShutdownInfo { enabled, url: url.to_string(), method, token_required })
}

/// Réponse de `server_get_config`, `server_start`, `server_stop` et charge de `server://state`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
  pub bind_ip: Option<String>,
  pub port: u16,
  pub allow_all: bool,
  pub has_key: bool,
  pub active: bool,
  pub running: bool,
  /// « ip:port » en écoute.
  pub address: Option<String>,
  /// Dernière erreur de démarrage.
  pub error: Option<String>,
  /// 4 premiers caractères de la clé (jamais la clé entière).
  pub key_prefix: Option<String>,
}

struct Running {
  addr: SocketAddr,
  shutdown: watch::Sender<bool>,
  task: tauri::async_runtime::JoinHandle<()>,
  /// Réponses aux sondes de découverte (UDP).
  discovery: tauri::async_runtime::JoinHandle<()>,
}

/// Échec de démarrage ; `retry` : l'interface n'existe peut-être pas encore.
struct StartError {
  message: String,
  retry: bool,
}

impl From<String> for StartError {
  fn from(message: String) -> Self {
    StartError { message, retry: false }
  }
}

pub struct Server {
  file: PathBuf,
  saved: Mutex<Saved>,
  /// Empreinte de la clé, partagée avec le serveur en marche (remplacement immédiat).
  keys: Arc<RwLock<Option<KeyHash>>>,
  /// Extinction à distance, partagée avec le serveur en marche.
  shutdown_info: Arc<RwLock<ShutdownInfo>>,
  limiter: Arc<Mutex<Limiter>>,
  running: Mutex<Option<Running>>,
  error: Mutex<Option<String>>,
  /// Un démarrage ou un arrêt à la fois.
  op: tokio::sync::Mutex<()>,
}

impl Server {
  fn open(file: PathBuf) -> Server {
    let saved: Saved = crate::localfile::read_json(&file).unwrap_or_default();
    let key = saved.key_hash.as_deref().and_then(auth::from_hex);
    let shutdown_info = Arc::new(RwLock::new(saved.shutdown.clone()));
    Server {
      file,
      saved: Mutex::new(saved),
      keys: Arc::new(RwLock::new(key)),
      shutdown_info,
      limiter: Arc::new(Mutex::new(Limiter::default())),
      running: Mutex::new(None),
      error: Mutex::new(None),
      op: tokio::sync::Mutex::new(()),
    }
  }

  /// Efface la clé (empreinte et clair), remet l'extinction à zéro et désactive le serveur.
  fn delete_key(&self) -> Result<(), String> {
    self.update(|s| {
      s.key_hash = None;
      s.key = None;
      s.active = false;
      s.shutdown = ShutdownInfo::default();
    })?;
    *self.shutdown_info.write().unwrap_or_else(|e| e.into_inner()) = ShutdownInfo::default();
    *self.keys.write().unwrap_or_else(|e| e.into_inner()) = None;
    *lock(&self.limiter) = Limiter::default();
    log("serveur supprimé");
    Ok(())
  }

  pub fn has_key(&self) -> bool {
    self.keys.read().unwrap_or_else(|e| e.into_inner()).is_some()
  }

  /// Adresse en écoute, si le serveur tourne.
  pub fn address(&self) -> Option<SocketAddr> {
    lock(&self.running).as_ref().map(|r| r.addr)
  }

  pub fn config(&self) -> ServerConfig {
    let saved = lock(&self.saved).clone();
    let address = self.address();
    ServerConfig {
      bind_ip: saved.bind_ip,
      port: saved.port,
      allow_all: saved.allow_all,
      has_key: self.has_key(),
      active: saved.active,
      running: address.is_some(),
      address: address.map(|a| a.to_string()),
      error: lock(&self.error).clone(),
      key_prefix: self.stored_key().map(|k| k.chars().take(4).collect()),
    }
  }

  /// Modifie et enregistre la configuration.
  fn update(&self, f: impl FnOnce(&mut Saved)) -> Result<(), String> {
    let mut saved = lock(&self.saved);
    let mut next = saved.clone();
    f(&mut next);
    if next != *saved {
      crate::localfile::write_json(&self.file, &next)?;
      *saved = next;
    }
    Ok(())
  }

  /// Enregistre la configuration d'extinction (effet immédiat sur la route HTTP).
  fn set_shutdown(&self, enabled: bool, url: &str, method: &str, token_required: bool) -> Result<ShutdownInfo, String> {
    let info = validate_shutdown(enabled, url, method, token_required)?;
    self.update(|s| s.shutdown = info.clone())?;
    *self.shutdown_info.write().unwrap_or_else(|e| e.into_inner()) = info.clone();
    Ok(info)
  }

  fn emit(&self, app: &AppHandle) {
    if let Err(e) = app.emit(EVENT_STATE, self.config()) {
      log(&format!("émission d'événement impossible : {e}"));
    }
  }

  fn generate_key(&self) -> Result<String, String> {
    let key = auth::generate_key()?;
    let hash = auth::hash_key(&key);
    self.update(|s| {
      s.key_hash = Some(auth::to_hex(&hash));
      s.key = Some(key.clone());
    })?;
    *self.keys.write().unwrap_or_else(|e| e.into_inner()) = Some(hash);
    // Nouvelle clé : les blocages liés à l'ancienne n'ont plus lieu d'être.
    *lock(&self.limiter) = Limiter::default();
    log("nouvelle clé d'API générée");
    Ok(key)
  }

  /// Clé en clair enregistrée, si elle correspond bien à l'empreinte en vigueur.
  fn stored_key(&self) -> Option<String> {
    let key = lock(&self.saved).key.clone()?;
    let current = (*self.keys.read().unwrap_or_else(|e| e.into_inner()))?;
    auth::hash_eq(&auth::hash_key(&key), &current).then_some(key)
  }

  /// Arrête le serveur en marche (s'il y en a un).
  async fn stop_running(&self) {
    let Some(mut r) = lock(&self.running).take() else { return };
    r.shutdown.send_replace(true);
    r.discovery.abort();
    if tokio::time::timeout(STOP_GRACE, &mut r.task).await.is_err() {
      r.task.abort();
    }
    log(&format!("serveur arrêté ({})", r.addr));
  }

  /// Valide puis démarre l'écoute (remplace un serveur déjà en marche).
  async fn start(&self, app: &AppHandle, bind_ip: &str, port: i64, allow_all: bool) -> Result<SocketAddr, StartError> {
    if !self.has_key() {
      return Err("Générez d'abord une clé d'API.".to_string().into());
    }
    let interfaces = tauri::async_runtime::spawn_blocking(net::list).await.unwrap_or_default();
    let addr = net::validate(bind_ip, port, allow_all, &interfaces).map_err(|message| StartError {
      retry: message.starts_with("Adresse d'écoute inconnue"),
      message,
    })?;
    self.stop_running().await;

    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| bind_error(addr, &e))?;
    let (shutdown, rx) = watch::channel(false);
    let state = Arc::new(HttpState {
      backend: Arc::new(AppBackend { app: app.clone() }),
      keys: self.keys.clone(),
      shutdown_info: self.shutdown_info.clone(),
      limiter: self.limiter.clone(),
      shutdown: rx.clone(),
    });
    let service = http::router(state).into_make_service_with_connect_info::<SocketAddr>();
    let discovery = discovery::spawn_responder(self.keys.clone(), addr, rx.clone());
    let mut stop = rx;
    let task = tauri::async_runtime::spawn(async move {
      let serve = axum::serve(listener, service).with_graceful_shutdown(async move { http::wait_shutdown(&mut stop).await });
      if let Err(e) = serve.await {
        log(&format!("serveur interrompu : {e}"));
      }
    });
    *lock(&self.running) = Some(Running { addr, shutdown, task, discovery });
    log(&format!("serveur en écoute sur {addr}"));

    // Prépare la détection du matériel (réponse rapide de `/api/v1/info`).
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
      let _ = crate::hardware::detect_async(&app2).await;
    });
    Ok(addr)
  }
}

fn bind_error(addr: SocketAddr, e: &std::io::Error) -> StartError {
  use std::io::ErrorKind;
  let (message, retry) = match e.kind() {
    ErrorKind::AddrInUse => (format!("Le port {} est déjà utilisé sur {} : choisissez-en un autre.", addr.port(), addr.ip()), false),
    ErrorKind::AddrNotAvailable => (format!("Adresse {} indisponible (interface absente ou déconnectée).", addr.ip()), true),
    ErrorKind::PermissionDenied => (format!("Port {} réservé ou interdit par Windows : choisissez-en un autre.", addr.port()), false),
    _ => (format!("Écoute impossible sur {addr} : {e}"), false),
  };
  StartError { message, retry }
}

fn set_fullscreen(app: &AppHandle, on: bool) {
  if let Some(w) = app.get_webview_window("main") {
    if let Err(e) = w.set_fullscreen(on) {
      log(&format!("plein écran impossible : {e}"));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Accès au moteur et au catalogue de cette machine
// ---------------------------------------------------------------------------------------------

/// Réponse de `/api/v1/info`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Info {
  app: &'static str,
  version: String,
  backend: &'static str,
  gpu_name: Option<String>,
  vram_bytes: Option<u64>,
  status: EngineStatus,
}

struct AppBackend {
  app: AppHandle,
}

impl AppBackend {
  fn engine(&self) -> Option<Engine> {
    self.app.try_state::<Engine>().map(|e| e.inner().clone())
  }
}

impl Backend for AppBackend {
  fn info(&self) -> BoxFuture<'static, Result<Value, String>> {
    let engine = self.engine();
    let version = self.app.package_info().version.to_string();
    Box::pin(async move {
      let engine = engine.ok_or("Moteur indisponible.")?;
      let info = tauri::async_runtime::spawn_blocking(move || {
        let backend = engine.info().backend;
        let hw = crate::hardware::detect(Some(&engine));
        let gpu = hw.gpus.into_iter().next();
        Info {
          app: "lucania",
          version,
          backend,
          gpu_name: gpu.as_ref().map(|g| g.name.clone()),
          vram_bytes: gpu.map(|g| g.vram_total_bytes),
          status: engine.status(),
        }
      })
      .await
      .map_err(|e| format!("Tâche interrompue : {e}"))?;
      serde_json::to_value(info).map_err(|e| format!("Réponse illisible : {e}"))
    })
  }

  fn status(&self) -> Value {
    let status = self.engine().map(|e| e.status()).unwrap_or_default();
    serde_json::to_value(status).unwrap_or(Value::Null)
  }

  fn call(&self, name: String, args: Value) -> BoxFuture<'static, Result<Value, CallError>> {
    let app = self.app.clone();
    Box::pin(async move { calls::local(&app, &name, args).await })
  }

  fn stop(&self, request_id: &str) {
    if let Some(e) = self.engine() {
      e.stop(Some(request_id));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Lancement et commandes Tauri
// ---------------------------------------------------------------------------------------------

/// Charge la configuration ; serveur actif : relancé en arrière-plan (appelé depuis `setup`).
pub fn setup(app: &tauri::App) {
  let base = app
    .path()
    .app_local_data_dir()
    .unwrap_or_else(|_| std::env::temp_dir().join("com.lucania.desktop"));
  let server = Server::open(base.join("server.json"));
  let active = lock(&server.saved).active;
  app.manage(server);
  if active {
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move { resume(handle).await });
  }
}

/// Relance le serveur enregistré comme actif ; échec définitif : `active` repasse à false.
async fn resume(app: AppHandle) {
  let server = app.state::<Server>();
  let deadline = Instant::now() + RESUME_FOR;
  loop {
    let r = {
      let _op = server.op.lock().await;
      let saved = lock(&server.saved).clone();
      // Arrêté ou relancé entre-temps par l'utilisateur.
      if !saved.active || server.address().is_some() {
        return;
      }
      match saved.bind_ip.as_deref() {
        Some(ip) => server.start(&app, ip, i64::from(saved.port), saved.allow_all).await,
        None => Err("Aucune adresse d'écoute enregistrée.".to_string().into()),
      }
    };
    match r {
      Ok(_) => {
        *lock(&server.error) = None;
        set_fullscreen(&app, true);
        server.emit(&app);
        return;
      }
      Err(e) if e.retry && Instant::now() < deadline => tokio::time::sleep(RESUME_RETRY).await,
      Err(e) => {
        log(&format!("relance du serveur impossible : {}", e.message));
        if let Err(w) = server.update(|s| s.active = false) {
          log(&w);
        }
        *lock(&server.error) = Some(e.message);
        server.emit(&app);
        return;
      }
    }
  }
}

#[tauri::command]
pub async fn server_get_config(server: State<'_, Server>) -> Result<ServerConfig, String> {
  Ok(server.config())
}

#[tauri::command]
pub async fn server_interfaces() -> Result<Vec<NetInterface>, String> {
  tauri::async_runtime::spawn_blocking(net::list)
    .await
    .map_err(|e| format!("Liste des interfaces interrompue : {e}"))
}

/// Nouvelle clé, renvoyée en clair et enregistrée (l'authentification utilise son empreinte).
#[tauri::command]
pub async fn server_generate_key(
  app: AppHandle,
  server: State<'_, Server>,
  remote: State<'_, crate::remote::Remote>,
) -> Result<String, String> {
  if remote.is_remote() {
    return Err("role_conflict".into());
  }
  let key = server.generate_key()?;
  server.emit(&app);
  Ok(key)
}

#[tauri::command]
pub async fn server_start(
  app: AppHandle,
  server: State<'_, Server>,
  bind_ip: String,
  port: i64,
  allow_all: Option<bool>,
) -> Result<ServerConfig, String> {
  let allow_all = allow_all.unwrap_or(false);
  let r = {
    let _op = server.op.lock().await;
    server.start(&app, &bind_ip, port, allow_all).await
  };
  match r {
    Ok(addr) => {
      let saved = server.update(|s| {
        s.bind_ip = Some(addr.ip().to_string());
        s.port = addr.port();
        s.allow_all = allow_all;
        s.active = true;
      });
      *lock(&server.error) = saved.as_ref().err().cloned();
      set_fullscreen(&app, true);
      server.emit(&app);
      Ok(server.config())
    }
    Err(e) => {
      log(&format!("démarrage du serveur impossible : {}", e.message));
      // Un serveur précédent a pu être arrêté : l'état enregistré suit la réalité.
      if server.address().is_none() {
        if let Err(w) = server.update(|s| s.active = false) {
          log(&w);
        }
      }
      *lock(&server.error) = Some(e.message.clone());
      server.emit(&app);
      Err(e.message)
    }
  }
}

#[tauri::command]
pub async fn server_stop(app: AppHandle, server: State<'_, Server>) -> Result<ServerConfig, String> {
  {
    let _op = server.op.lock().await;
    server.stop_running().await;
  }
  let r = server.update(|s| s.active = false);
  *lock(&server.error) = None;
  set_fullscreen(&app, false);
  server.emit(&app);
  r?;
  Ok(server.config())
}

/// Configuration d'extinction à distance enregistrée.
#[tauri::command]
pub async fn server_get_shutdown(server: State<'_, Server>) -> Result<ShutdownInfo, String> {
  Ok(lock(&server.saved).shutdown.clone())
}

/// Enregistre l'extinction à distance (serveur en marche ou non).
#[tauri::command]
pub async fn server_set_shutdown(
  server: State<'_, Server>,
  enabled: bool,
  url: String,
  method: String,
  token_required: bool,
) -> Result<ShutdownInfo, String> {
  server.set_shutdown(enabled, &url, &method, token_required)
}

/// Supprime le rôle serveur : arrêt, clé effacée (la configuration d'écoute est gardée).
#[tauri::command]
pub async fn server_delete(app: AppHandle, server: State<'_, Server>) -> Result<ServerConfig, String> {
  let r = {
    let _op = server.op.lock().await;
    server.stop_running().await;
    server.delete_key()
  };
  *lock(&server.error) = None;
  set_fullscreen(&app, false);
  server.emit(&app);
  r?;
  Ok(server.config())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn configuration_enregistree() {
    let dir = std::env::temp_dir().join(format!("lucania-server-test-{}", std::process::id()));
    let file = dir.join("server.json");
    let _ = std::fs::remove_dir_all(&dir);
    let s = Server::open(file.clone());
    let c = s.config();
    assert_eq!((c.port, c.has_key, c.active, c.running), (net::DEFAULT_PORT, false, false, false));
    let key = s.generate_key().unwrap();
    s.update(|x| {
      x.bind_ip = Some("10.0.0.2".into());
      x.active = true;
    })
    .unwrap();
    // L'empreinte et la clé (ré-affichable) sont écrites.
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.contains(&key));
    assert!(text.contains(&auth::to_hex(&auth::hash_key(&key))));
    assert!(text.contains("\"bindIp\""));
    let s2 = Server::open(file);
    let c2 = s2.config();
    assert!(c2.has_key && c2.active && !c2.running);
    assert!(auth::verify(&key, s2.keys.read().unwrap().as_ref()));
    assert_eq!(s2.config().key_prefix, Some(key.chars().take(4).collect()));
    assert_eq!(s2.stored_key(), Some(key));
    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn suppression_du_serveur() {
    let dir = std::env::temp_dir().join(format!("lucania-server-del-{}", std::process::id()));
    let file = dir.join("server.json");
    let _ = std::fs::remove_dir_all(&dir);
    let s = Server::open(file.clone());
    assert_eq!(s.config().key_prefix, None);
    s.generate_key().unwrap();
    s.update(|x| {
      x.bind_ip = Some("10.0.0.2".into());
      x.active = true;
    })
    .unwrap();
    assert!(s.config().key_prefix.is_some());
    s.delete_key().unwrap();
    let c = s.config();
    assert!(!c.has_key && !c.active && c.key_prefix.is_none());
    assert_eq!(c.bind_ip.as_deref(), Some("10.0.0.2"));
    let c2 = Server::open(file).config();
    assert!(!c2.has_key && !c2.active && c2.key_prefix.is_none());
    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn shutdown_info_serialisee() {
    assert_eq!(
      serde_json::to_value(ShutdownInfo::default()).unwrap(),
      serde_json::json!({ "enabled": false, "url": "", "method": "GET", "tokenRequired": false })
    );
    let i: ShutdownInfo = serde_json::from_str(r#"{"enabled":true,"url":"http://a:1/x","method":"POST","tokenRequired":true}"#).unwrap();
    assert_eq!(i, ShutdownInfo { enabled: true, url: "http://a:1/x".into(), method: "POST".into(), token_required: true });
  }

  #[test]
  fn validation_extinction() {
    for (url, method) in [("", "GET"), ("pas une url", "GET"), ("ftp://h/x", "GET"), ("http://", "GET"), ("http://h/x", "PUT"), ("http://h/x", "")] {
      assert!(validate_shutdown(true, url, method, false).is_err(), "{url} {method}");
    }
    let ok = validate_shutdown(true, " https://h:8080/off?x=1 ", "post", true).unwrap();
    assert_eq!(ok, ShutdownInfo { enabled: true, url: "https://h:8080/off?x=1".into(), method: "POST".into(), token_required: true });
    // Désactivée : jamais d'erreur, les valeurs sont gardées.
    let off = validate_shutdown(false, "http://h/x", "POST", true).unwrap();
    assert_eq!((off.enabled, off.url.as_str(), off.method.as_str(), off.token_required), (false, "http://h/x", "POST", true));
    assert_eq!(validate_shutdown(false, "", "zzz", false).unwrap(), ShutdownInfo::default());
  }

  #[test]
  fn extinction_enregistree_et_supprimee() {
    let dir = std::env::temp_dir().join(format!("lucania-server-off-{}", std::process::id()));
    let file = dir.join("server.json");
    let _ = std::fs::remove_dir_all(&dir);
    let s = Server::open(file.clone());
    assert!(s.set_shutdown(true, "nope", "GET", false).is_err());
    assert_eq!(*s.shutdown_info.read().unwrap(), ShutdownInfo::default());
    s.generate_key().unwrap();
    let info = s.set_shutdown(true, "http://10.0.0.2:9000/off", "POST", true).unwrap();
    assert_eq!(*s.shutdown_info.read().unwrap(), info);
    let s2 = Server::open(file.clone());
    assert_eq!(lock(&s2.saved).shutdown, info);
    assert_eq!(*s2.shutdown_info.read().unwrap(), info);
    s2.delete_key().unwrap();
    assert_eq!(lock(&s2.saved).shutdown, ShutdownInfo::default());
    assert_eq!(*s2.shutdown_info.read().unwrap(), ShutdownInfo::default());
    assert_eq!(lock(&Server::open(file).saved).shutdown, ShutdownInfo::default());
    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn ancien_fichier_sans_champ_shutdown() {
    let dir = std::env::temp_dir().join(format!("lucania-server-noshut-{}", std::process::id()));
    let file = dir.join("server.json");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let hash = auth::to_hex(&auth::hash_key("luc_x"));
    std::fs::write(&file, format!(r#"{{"bindIp":"10.0.0.2","port":4750,"active":true,"keyHash":"{hash}","key":"luc_x"}}"#)).unwrap();
    let s = Server::open(file);
    assert!(s.config().has_key);
    assert_eq!(lock(&s.saved).shutdown, ShutdownInfo::default());
    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn ancien_fichier_sans_cle_en_clair() {
    let dir = std::env::temp_dir().join(format!("lucania-server-old-{}", std::process::id()));
    let file = dir.join("server.json");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let hash = auth::to_hex(&auth::hash_key("luc_ancienne"));
    std::fs::write(&file, format!(r#"{{"bindIp":"10.0.0.2","port":4750,"allowAll":false,"active":true,"keyHash":"{hash}"}}"#)).unwrap();
    let s = Server::open(file);
    let c = s.config();
    assert!(c.has_key && c.active);
    assert_eq!(c.key_prefix, None);
    assert_eq!(s.stored_key(), None);
    // Une clé en clair qui ne correspond pas à l'empreinte n'est jamais renvoyée.
    s.update(|x| x.key = Some("luc_autre".into())).unwrap();
    assert_eq!(s.stored_key(), None);
    s.update(|x| x.key = Some("luc_ancienne".into())).unwrap();
    assert_eq!(s.stored_key().as_deref(), Some("luc_ancienne"));
    let _ = std::fs::remove_dir_all(dir);
  }
}
