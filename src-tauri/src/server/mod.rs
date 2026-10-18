//! Mode serveur (la « tour ») : API HTTP dans le processus Tauri, exposant le moteur et le
//! catalogue Hugging Face à un autre poste (portable, à travers un tunnel WireGuard).
//!
//! - `auth` : clé d'API (empreinte SHA-256 seule enregistrée) et limite de débit ;
//! - `net` : interfaces IPv4 et validation de l'adresse d'écoute ;
//! - `http` : routeur axum (routes `/api/v1/*`).
//!
//! Configuration : `<app_local_data_dir>/server.json` (`bindIp`, `port`, `allowAll`, `active`,
//! `keyHash`). Serveur actif au lancement de l'app : relancé avec la configuration enregistrée.

pub mod auth;
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
}

impl Default for Saved {
  fn default() -> Self {
    Saved { bind_ip: None, port: net::DEFAULT_PORT, allow_all: false, active: false, key_hash: None }
  }
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
}

struct Running {
  addr: SocketAddr,
  shutdown: watch::Sender<bool>,
  task: tauri::async_runtime::JoinHandle<()>,
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
    Server {
      file,
      saved: Mutex::new(saved),
      keys: Arc::new(RwLock::new(key)),
      limiter: Arc::new(Mutex::new(Limiter::default())),
      running: Mutex::new(None),
      error: Mutex::new(None),
      op: tokio::sync::Mutex::new(()),
    }
  }

  fn has_key(&self) -> bool {
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

  fn emit(&self, app: &AppHandle) {
    if let Err(e) = app.emit(EVENT_STATE, self.config()) {
      log(&format!("émission d'événement impossible : {e}"));
    }
  }

  fn generate_key(&self) -> Result<String, String> {
    let key = auth::generate_key()?;
    let hash = auth::hash_key(&key);
    self.update(|s| s.key_hash = Some(auth::to_hex(&hash)))?;
    *self.keys.write().unwrap_or_else(|e| e.into_inner()) = Some(hash);
    // Nouvelle clé : les blocages liés à l'ancienne n'ont plus lieu d'être.
    *lock(&self.limiter) = Limiter::default();
    log("nouvelle clé d'API générée");
    Ok(key)
  }

  /// Arrête le serveur en marche (s'il y en a un).
  async fn stop_running(&self) {
    let Some(mut r) = lock(&self.running).take() else { return };
    r.shutdown.send_replace(true);
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
      limiter: self.limiter.clone(),
      shutdown: rx.clone(),
    });
    let service = http::router(state).into_make_service_with_connect_info::<SocketAddr>();
    let mut stop = rx;
    let task = tauri::async_runtime::spawn(async move {
      let serve = axum::serve(listener, service).with_graceful_shutdown(async move { http::wait_shutdown(&mut stop).await });
      if let Err(e) = serve.await {
        log(&format!("serveur interrompu : {e}"));
      }
    });
    *lock(&self.running) = Some(Running { addr, shutdown, task });
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

/// Nouvelle clé, renvoyée une seule fois en clair (seule son empreinte est enregistrée).
#[tauri::command]
pub async fn server_generate_key(app: AppHandle, server: State<'_, Server>) -> Result<String, String> {
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
    // Seule l'empreinte est écrite, jamais la clé.
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(!text.contains(&key));
    assert!(text.contains(&auth::to_hex(&auth::hash_key(&key))));
    assert!(text.contains("\"bindIp\""));
    let s2 = Server::open(file);
    let c2 = s2.config();
    assert!(c2.has_key && c2.active && !c2.running);
    assert!(auth::verify(&key, s2.keys.read().unwrap().as_ref()));
    let _ = std::fs::remove_dir_all(dir);
  }
}
