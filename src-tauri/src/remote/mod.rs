//! Mode client (le portable) : en mode « distant », les commandes de la liste blanche
//! (`calls::RELAYED`) et `engine_generate` sont relayées vers la tour ; les pages ne changent
//! pas. Les événements de la tour (statut du moteur, téléchargements) sont suivis par un flux
//! SSE et réémis localement sous les mêmes noms.
//!
//! Configuration : `<app_local_data_dir>/remote.json` (`mode`, `url`, `key` ; clé en clair, comme
//! le jeton Hugging Face). Restent toujours locales : `hf_avatars`, journaux, désinstallation,
//! `server_*` et `remote_*`.

pub mod sse;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::{Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::engine::commands::{EVENT_STATUS, EVENT_TOKEN};
use crate::engine::{Engine, TokenEvent};
use crate::hf::commands::{EVENT_DOWNLOAD, EVENT_REMOVED};
use crate::server::http::{KEY_REFUSED, TOO_MANY};
use sse::SseParser;

pub const EVENT_STATE: &str = "remote://state";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Flux SSE : la tour envoie un maintien de connexion toutes les 15 s.
const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(60);
const TEST_TIMEOUT: Duration = Duration::from_secs(5);
const RETRY_MIN: Duration = Duration::from_secs(2);
const RETRY_MAX: Duration = Duration::from_secs(30);

const INVALID: &str = "Réponse invalide : ce n'est pas un serveur Lucania.";
const LOST: &str = "Connexion à la tour interrompue pendant la génération.";

/// Mode distant actif (lu par les émetteurs du moteur et de Hugging Face).
static REMOTE: AtomicBool = AtomicBool::new(false);

pub fn is_remote() -> bool {
  REMOTE.load(Ordering::SeqCst)
}

/// Journal (stderr et journal de session). Ni la clé ni le contenu des messages n'y figurent.
fn log(msg: &str) {
  eprintln!("[distant] {msg}");
  crate::crashlog::note(&format!("[distant] {msg}"));
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
  m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
  #[default]
  Local,
  Remote,
}

/// Contenu de `remote.json` (clé vide = aucune).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct Saved {
  mode: Mode,
  url: String,
  key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfig {
  pub mode: Mode,
  pub url: String,
  pub has_key: bool,
  /// 4 premiers caractères de la clé enregistrée.
  pub key_prefix: Option<String>,
}

/// Réponse de `remote_state` et charge de `remote://state`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RemoteState {
  pub mode: Mode,
  pub connected: bool,
  pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
  pub latency_ms: u64,
  pub version: String,
  pub backend: String,
  pub gpu_name: Option<String>,
  pub vram_bytes: Option<u64>,
  pub loaded_model: Option<String>,
}

#[derive(Default)]
struct Link {
  connected: bool,
  error: Option<String>,
}

#[derive(Clone)]
struct Clients {
  /// Appels `/call` et `/info` (délai par requête).
  call: Client,
  /// Flux SSE (délai de lecture : la tour envoie un maintien de connexion).
  stream: Client,
}

fn build_clients() -> Result<Clients, String> {
  let base = || Client::builder().connect_timeout(CONNECT_TIMEOUT).tcp_keepalive(Duration::from_secs(15)).no_proxy();
  let err = |e: reqwest::Error| format!("Client HTTP indisponible : {e}");
  Ok(Clients { call: base().build().map_err(err)?, stream: base().read_timeout(STREAM_READ_TIMEOUT).build().map_err(err)? })
}

pub struct Remote {
  file: PathBuf,
  saved: Mutex<Saved>,
  clients: Result<Clients, String>,
  link: Mutex<Link>,
  /// Incrémenté à chaque changement de configuration : une tâche d'abonnement périmée se tait.
  epoch: AtomicU64,
  events: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl Remote {
  fn open(file: PathBuf) -> Remote {
    let saved: Saved = crate::localfile::read_json(&file).unwrap_or_default();
    let clients = build_clients();
    if let Err(e) = &clients {
      log(e);
    }
    Remote { file, saved: Mutex::new(saved), clients, link: Mutex::new(Link::default()), epoch: AtomicU64::new(0), events: Mutex::new(None) }
  }

  /// Vrai si ce poste est en mode distant (récepteur d'une tour).
  pub fn is_remote(&self) -> bool {
    lock(&self.saved).mode == Mode::Remote
  }

  fn config(&self) -> RemoteConfig {
    let s = lock(&self.saved);
    RemoteConfig { mode: s.mode, url: s.url.clone(), has_key: !s.key.is_empty(), key_prefix: Some(s.key.chars().take(4).collect()).filter(|p: &String| !p.is_empty()) }
  }

  fn state(&self) -> RemoteState {
    let mode = lock(&self.saved).mode;
    let link = lock(&self.link);
    RemoteState { mode, connected: mode == Mode::Remote && link.connected, error: link.error.clone() }
  }

  fn emit_state(&self, app: &AppHandle) {
    if let Err(e) = app.emit(EVENT_STATE, self.state()) {
      log(&format!("émission d'événement impossible : {e}"));
    }
  }

  /// Met à jour l'état de la liaison (tâche d'abonnement encore valable seulement).
  fn set_link(&self, app: &AppHandle, epoch: u64, connected: bool, error: Option<String>) {
    if self.epoch.load(Ordering::SeqCst) != epoch {
      return;
    }
    let changed = {
      let mut link = lock(&self.link);
      let changed = link.connected != connected || link.error != error;
      *link = Link { connected, error };
      changed
    };
    if changed {
      self.emit_state(app);
    }
  }

  /// Tour configurée, si le mode distant est actif.
  fn tower(&self) -> Option<Tower> {
    let s = lock(&self.saved);
    (s.mode == Mode::Remote && !s.url.is_empty() && !s.key.is_empty()).then(|| Tower {
      url: s.url.clone(),
      key: s.key.clone(),
      clients: self.clients.clone(),
    })
  }

  /// Applique le mode enregistré : bascule du relais, (re)démarrage ou arrêt de l'abonnement.
  fn apply(&self, app: &AppHandle) {
    let tower = self.tower();
    let was_remote = REMOTE.swap(tower.is_some(), Ordering::SeqCst);
    let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(h) = lock(&self.events).take() {
      h.abort();
    }
    *lock(&self.link) = Link::default();
    match tower {
      Some(t) => {
        log("mode distant : relais vers la tour");
        let handle = app.clone();
        *lock(&self.events) = Some(tauri::async_runtime::spawn(async move { events_loop(handle, t, epoch).await }));
      }
      None if was_remote => {
        log("mode local");
        // Les pages reprennent le statut du moteur local.
        if let Some(e) = app.try_state::<Engine>() {
          let _ = app.emit(EVENT_STATUS, e.status());
        }
      }
      None => {}
    }
    self.emit_state(app);
  }
}

/// Tour à joindre, si le mode distant est actif (sinon : exécution locale).
pub fn active(app: &AppHandle) -> Option<Tower> {
  if !is_remote() {
    return None;
  }
  app.try_state::<Remote>()?.tower()
}

// ---------------------------------------------------------------------------------------------
// Relais
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct ErrorBody {
  error: String,
}

#[derive(Deserialize)]
struct TokenData {
  text: String,
}

/// Délai d'un appel relayé (le chargement d'un gros modèle peut prendre des minutes).
fn call_timeout(name: &str) -> Duration {
  match name {
    "engine_load" => Duration::from_secs(30 * 60),
    "engine_unload" | "engine_delete_model" => Duration::from_secs(5 * 60),
    _ => Duration::from_secs(2 * 60),
  }
}

/// Erreur réseau, avec la cause la plus précise (message du système).
fn unreachable(e: &reqwest::Error) -> String {
  if e.is_timeout() {
    return "Tour injoignable : délai dépassé.".into();
  }
  let mut msg = e.to_string();
  let mut src = std::error::Error::source(e);
  while let Some(s) = src {
    msg = s.to_string();
    src = s.source();
  }
  format!("Tour injoignable : {msg}")
}

/// Message d'une réponse en erreur de la tour.
async fn http_error(resp: Response) -> String {
  match resp.status().as_u16() {
    401 => KEY_REFUSED.into(),
    429 => TOO_MANY.into(),
    code => match resp.json::<ErrorBody>().await {
      Ok(b) => b.error,
      Err(_) => format!("{INVALID} (HTTP {code})"),
    },
  }
}

#[derive(Clone)]
pub struct Tower {
  url: String,
  key: String,
  clients: Result<Clients, String>,
}

impl Tower {
  fn clients(&self) -> Result<&Clients, String> {
    self.clients.as_ref().map_err(Clone::clone)
  }

  /// Relaie une commande : `POST /api/v1/call/<nom>` avec les arguments de `invoke`.
  pub async fn call(&self, name: &str, args: Value) -> Result<Value, String> {
    let resp = self
      .clients()?
      .call
      .post(format!("{}/api/v1/call/{name}", self.url))
      .bearer_auth(&self.key)
      .json(&args)
      .timeout(call_timeout(name))
      .send()
      .await
      .map_err(|e| unreachable(&e))?;
    if !resp.status().is_success() {
      return Err(http_error(resp).await);
    }
    resp.json::<Value>().await.map_err(|e| if e.is_timeout() { unreachable(&e) } else { INVALID.into() })
  }

  /// Génération sur la tour : jetons réémis localement (`engine://token`), résultat final.
  pub async fn generate(&self, app: &AppHandle, args: Value) -> Result<Value, String> {
    let request_id = args.get("requestId").and_then(Value::as_str).unwrap_or_default().to_string();
    let resp = self
      .clients()?
      .stream
      .post(format!("{}/api/v1/generate", self.url))
      .bearer_auth(&self.key)
      .json(&args)
      .send()
      .await
      .map_err(|e| unreachable(&e))?;
    if !resp.status().is_success() {
      return Err(http_error(resp).await);
    }
    let mut parser = SseParser::default();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
      let chunk = chunk.map_err(|e| format!("{LOST} ({})", unreachable(&e)))?;
      for ev in parser.push(&chunk) {
        match ev.event.as_str() {
          "token" => {
            if let Ok(t) = serde_json::from_str::<TokenData>(&ev.data) {
              let _ = app.emit(EVENT_TOKEN, TokenEvent { request_id: request_id.clone(), text: t.text });
            }
          }
          "done" => return serde_json::from_str::<Value>(&ev.data).map_err(|_| INVALID.to_string()),
          "error" => {
            return Err(serde_json::from_str::<ErrorBody>(&ev.data).map(|b| b.error).unwrap_or_else(|_| INVALID.into()));
          }
          _ => {}
        }
      }
    }
    Err(LOST.into())
  }

  async fn open_events(&self) -> Result<Response, String> {
    let resp = self
      .clients()?
      .stream
      .get(format!("{}/api/v1/events", self.url))
      .bearer_auth(&self.key)
      .send()
      .await
      .map_err(|e| unreachable(&e))?;
    if resp.status().is_success() { Ok(resp) } else { Err(http_error(resp).await) }
  }
}

/// Réémet localement un événement de la tour.
fn relay_event(app: &AppHandle, ev: &sse::SseEvent) {
  let name = match ev.event.as_str() {
    "status" => EVENT_STATUS,
    "download" => EVENT_DOWNLOAD,
    "download-removed" => EVENT_REMOVED,
    _ => return,
  };
  if let Ok(v) = serde_json::from_str::<Value>(&ev.data) {
    let _ = app.emit(name, v);
  }
}

/// Lit le flux d'événements jusqu'à sa coupure ; renvoie la raison.
async fn read_events(app: &AppHandle, resp: Response) -> String {
  let mut parser = SseParser::default();
  let mut stream = resp.bytes_stream();
  loop {
    match stream.next().await {
      Some(Ok(chunk)) => {
        for ev in parser.push(&chunk) {
          relay_event(app, &ev);
        }
      }
      Some(Err(e)) => return unreachable(&e),
      None => return "La tour a fermé la connexion.".into(),
    }
  }
}

/// Abonnement aux événements de la tour, reconnecté avec une attente croissante (2 s -> 30 s).
/// Clé refusée : abandon (la configuration doit changer).
async fn events_loop(app: AppHandle, tower: Tower, epoch: u64) {
  let remote = app.state::<Remote>();
  let mut delay = RETRY_MIN;
  loop {
    let error = match tower.open_events().await {
      Ok(resp) => {
        remote.set_link(&app, epoch, true, None);
        log("connecté à la tour");
        delay = RETRY_MIN;
        read_events(&app, resp).await
      }
      Err(e) => e,
    };
    remote.set_link(&app, epoch, false, Some(error.clone()));
    if error == KEY_REFUSED {
      log("clé d'API refusée par la tour : abonnement arrêté");
      return;
    }
    tokio::time::sleep(delay).await;
    delay = (delay * 2).min(RETRY_MAX);
  }
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

/// Adresse de la tour normalisée : « http(s)://hôte:port », sans chemin ni « / » final.
pub fn normalize_url(input: &str) -> Result<String, String> {
  let s = input.trim();
  let lower = s.to_ascii_lowercase();
  let Some(after) = ["http://", "https://"].iter().find(|p| lower.starts_with(**p)).map(|p| &s[p.len()..]) else {
    return Err("Adresse invalide : elle doit commencer par http:// ou https://.".into());
  };
  let url = reqwest::Url::parse(s).map_err(|_| format!("Adresse invalide : « {s} »."))?;
  if !url.username().is_empty() || url.password().is_some() {
    return Err("Adresse invalide : pas d'identifiants dans l'adresse.".into());
  }
  if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
    return Err("Adresse invalide : indiquez seulement l'hôte et le port, sans chemin (ex. http://10.0.0.1:4750).".into());
  }
  let host = url.host_str().filter(|h| !h.is_empty()).ok_or_else(|| format!("Adresse invalide : « {s} »."))?;
  let authority = after.split(['/', '?', '#']).next().unwrap_or_default();
  let explicit_port = match authority.rsplit_once(']') {
    Some((_, tail)) => tail.starts_with(':'),
    None => authority.contains(':'),
  };
  let port = url.port_or_known_default().filter(|_| explicit_port);
  let Some(port) = port else {
    return Err("Adresse invalide : indiquez le port (ex. http://10.0.0.1:4750).".into());
  };
  Ok(format!("{}://{host}:{port}", url.scheme()))
}

/// L'adresse normalisée désigne-t-elle le serveur en écoute sur cette machine ?
fn is_self(url: &str, listening: SocketAddr, local_ips: &[String]) -> bool {
  let Ok(u) = reqwest::Url::parse(url) else { return false };
  if u.port_or_known_default() != Some(listening.port()) {
    return false;
  }
  let Some(host) = u.host_str() else { return false };
  let host = host.trim_start_matches('[').trim_end_matches(']');
  let ip = if host.eq_ignore_ascii_case("localhost") {
    IpAddr::V4(Ipv4Addr::LOCALHOST)
  } else {
    match host.parse::<IpAddr>() {
      Ok(ip) => ip,
      Err(_) => return false,
    }
  };
  if listening.ip().is_unspecified() {
    ip.is_loopback() || ip.is_unspecified() || local_ips.iter().any(|l| *l == ip.to_string())
  } else {
    ip == listening.ip()
  }
}

/// Clé d'API saisie : vide permis (effacement), sinon caractères visibles seulement.
pub(crate) fn valid_key(key: &str) -> bool {
  key.len() <= 512 && key.bytes().all(|c| c.is_ascii_graphic())
}

// ---------------------------------------------------------------------------------------------
// Lancement et commandes Tauri
// ---------------------------------------------------------------------------------------------

/// Charge la configuration et applique le mode (appelé depuis `setup`, avant le moteur).
pub fn setup(app: &tauri::App) {
  let base = app
    .path()
    .app_local_data_dir()
    .unwrap_or_else(|_| std::env::temp_dir().join("com.lucania.desktop"));
  app.manage(Remote::open(base.join("remote.json")));
  app.state::<Remote>().apply(app.handle());
}

#[tauri::command]
pub async fn remote_get_config(remote: State<'_, Remote>) -> Result<RemoteConfig, String> {
  Ok(remote.config())
}

#[tauri::command]
pub async fn remote_state(remote: State<'_, Remote>) -> Result<RemoteState, String> {
  Ok(remote.state())
}

/// `key` absente ou null : clé actuelle gardée ; "" : clé effacée.
#[tauri::command]
pub async fn remote_set_config(
  app: AppHandle,
  remote: State<'_, Remote>,
  server: State<'_, crate::server::Server>,
  mode: String,
  url: Option<String>,
  key: Option<String>,
) -> Result<RemoteConfig, String> {
  let mode = match mode.as_str() {
    "local" => Mode::Local,
    "remote" => Mode::Remote,
    _ => return Err("Mode invalide : « local » ou « remote » attendu.".into()),
  };
  let mut next = lock(&remote.saved).clone();
  next.mode = mode;
  if let Some(u) = url {
    let u = u.trim();
    next.url = if u.is_empty() { String::new() } else { normalize_url(u)? };
  }
  if let Some(k) = key {
    let k = k.trim();
    if !valid_key(k) {
      return Err("Clé d'API invalide.".into());
    }
    next.key = k.to_string();
  }
  if mode == Mode::Remote {
    if server.has_key() {
      return Err("role_conflict".into());
    }
    if next.url.is_empty() {
      return Err("Indiquez l'adresse de la tour.".into());
    }
    if next.key.is_empty() {
      return Err("Indiquez la clé d'API de la tour.".into());
    }
    let listening = app.try_state::<crate::server::Server>().and_then(|s| s.address());
    if let Some(addr) = listening {
      let local_ips: Vec<String> = tauri::async_runtime::spawn_blocking(crate::server::net::list)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|i| i.ip)
        .collect();
      if is_self(&next.url, addr, &local_ips) {
        return Err("Cette adresse est celle du serveur de cette machine : indiquez celle de la tour.".into());
      }
    }
  }
  {
    let mut saved = lock(&remote.saved);
    if *saved != next {
      crate::localfile::write_json(&remote.file, &next)?;
      *saved = next;
    }
  }
  remote.apply(&app);
  Ok(remote.config())
}

/// Teste une tour (`GET /api/v1/info`, 5 s au plus). `key` absente : clé enregistrée.
#[tauri::command]
pub async fn remote_test(remote: State<'_, Remote>, url: String, key: Option<String>) -> Result<TestResult, String> {
  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct Status {
    loaded_model: Option<String>,
  }
  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct Info {
    app: String,
    version: String,
    backend: String,
    gpu_name: Option<String>,
    vram_bytes: Option<u64>,
    status: Status,
  }

  let url = normalize_url(&url)?;
  let key = key
    .map(|k| k.trim().to_string())
    .filter(|k| !k.is_empty())
    .or_else(|| Some(lock(&remote.saved).key.clone()).filter(|k| !k.is_empty()))
    .ok_or("Aucune clé d'API : indiquez celle de la tour.")?;
  let client = remote.clients.as_ref().map_err(Clone::clone)?.call.clone();
  let start = Instant::now();
  let resp = client
    .get(format!("{url}/api/v1/info"))
    .bearer_auth(&key)
    .timeout(TEST_TIMEOUT)
    .send()
    .await
    .map_err(|e| unreachable(&e))?;
  let latency_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
  if !resp.status().is_success() {
    return Err(http_error(resp).await);
  }
  let info: Info = resp.json().await.map_err(|e| if e.is_timeout() { unreachable(&e) } else { INVALID.into() })?;
  if info.app != "lucania" {
    return Err(INVALID.into());
  }
  Ok(TestResult {
    latency_ms,
    version: info.version,
    backend: info.backend,
    gpu_name: info.gpu_name,
    vram_bytes: info.vram_bytes,
    loaded_model: info.status.loaded_model,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn normalisation_d_url() {
    assert_eq!(normalize_url(" http://10.0.0.1:4750/ "), Ok("http://10.0.0.1:4750".into()));
    assert_eq!(normalize_url("HTTP://Tour.Local:4750"), Ok("http://tour.local:4750".into()));
    assert_eq!(normalize_url("https://[fd00::1]:4750"), Ok("https://[fd00::1]:4750".into()));
    assert_eq!(normalize_url("http://10.0.0.1:80"), Ok("http://10.0.0.1:80".into()));
    for bad in [
      "10.0.0.1:4750",
      "ftp://10.0.0.1:4750",
      "http://10.0.0.1",
      "http://10.0.0.1/api",
      "http://10.0.0.1:4750/api/v1",
      "http://10.0.0.1:4750?x=1",
      "http://10.0.0.1:4750#a",
      "http://user:pw@10.0.0.1:4750",
      "http://:4750",
      "http://10.0.0.1:99999",
      "",
    ] {
      assert!(normalize_url(bad).is_err(), "{bad}");
    }
  }

  #[test]
  fn pas_de_boucle_vers_soi() {
    let ips = vec!["10.0.0.2".to_string(), "127.0.0.1".to_string()];
    let on_wg: SocketAddr = ([10, 0, 0, 2], 4750).into();
    assert!(is_self("http://10.0.0.2:4750", on_wg, &ips));
    assert!(!is_self("http://10.0.0.1:4750", on_wg, &ips));
    assert!(!is_self("http://10.0.0.2:4751", on_wg, &ips));
    assert!(!is_self("http://127.0.0.1:4750", on_wg, &ips));
    let all: SocketAddr = ([0, 0, 0, 0], 4750).into();
    assert!(is_self("http://127.0.0.1:4750", all, &ips));
    assert!(is_self("http://localhost:4750", all, &ips));
    assert!(is_self("http://10.0.0.2:4750", all, &ips));
    assert!(!is_self("http://10.0.0.9:4750", all, &ips));
    assert!(!is_self("http://tour:4750", all, &ips));
  }

  #[test]
  fn cle_saisie() {
    assert!(valid_key(""));
    assert!(valid_key("luc_abc-DEF_123"));
    assert!(!valid_key("luc abc"));
    assert!(!valid_key(&"a".repeat(513)));
  }

  #[test]
  fn etats_serialises() {
    let s = RemoteState { mode: Mode::Remote, connected: false, error: Some("x".into()) };
    assert_eq!(serde_json::to_value(s).unwrap(), serde_json::json!({ "mode": "remote", "connected": false, "error": "x" }));
    let c = RemoteConfig { mode: Mode::Local, url: String::new(), has_key: true, key_prefix: Some("luc_".into()) };
    assert_eq!(serde_json::to_value(c).unwrap(), serde_json::json!({ "mode": "local", "url": "", "hasKey": true, "keyPrefix": "luc_" }));
  }

  #[test]
  fn prefixe_de_cle() {
    let dir = std::env::temp_dir().join(format!("lucania-remote-test-{}", std::process::id()));
    let r = Remote::open(dir.join("remote.json"));
    assert_eq!(r.config().key_prefix, None);
    assert!(!r.is_remote());
    lock(&r.saved).key = "luc_secret".into();
    let c = r.config();
    assert_eq!((c.has_key, c.key_prefix.as_deref()), (true, Some("luc_")));
    *lock(&r.saved) = Saved::default();
    assert_eq!(r.config().key_prefix, None);
  }
}
