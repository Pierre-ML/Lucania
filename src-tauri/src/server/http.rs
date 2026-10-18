//! API HTTP de la tour (préfixe `/api/v1`), indépendante de Tauri pour être testée en mémoire.
//!
//! - toutes les routes exigent `Authorization: Bearer <clé>` (empreintes comparées en temps
//!   constant) ; échecs limités par IP et globalement (`auth::Limiter`) ;
//! - erreurs en JSON `{ "error": "message" }`, aucun en-tête CORS, corps limité.

use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Request, State};
use axum::http::StatusCode;
use axum::http::header::AUTHORIZATION;
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use futures_util::stream;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::broadcast::error::{RecvError, TryRecvError};
use tokio::sync::{mpsc, watch};

use super::auth::{self, KeyHash, Limiter};
use crate::bus::{self, BusEvent};
use crate::calls::{self, CallError};

/// Corps de requête limité : une longue conversation tient largement dans 2 Mo.
pub const BODY_LIMIT: usize = 2 * 1024 * 1024;
const KEEPALIVE: Duration = Duration::from_secs(15);

pub const KEY_REFUSED: &str = "Clé d'API refusée.";
pub const TOO_MANY: &str = "Trop de tentatives, réessayez plus tard.";

/// Ce que l'API expose de la machine (l'app réelle, ou un double dans les tests).
pub trait Backend: Send + Sync + 'static {
  /// Réponse de `/api/v1/info`.
  fn info(&self) -> BoxFuture<'static, Result<Value, String>>;
  /// Statut du moteur (JSON de `EngineStatus`).
  fn status(&self) -> Value;
  /// Exécute localement une commande (arguments JSON de `invoke`).
  fn call(&self, name: String, args: Value) -> BoxFuture<'static, Result<Value, CallError>>;
  /// Arrête la génération `request_id` si c'est elle qui tourne.
  fn stop(&self, request_id: &str);
}

pub struct HttpState {
  pub backend: Arc<dyn Backend>,
  pub keys: Arc<RwLock<Option<KeyHash>>>,
  pub limiter: Arc<Mutex<Limiter>>,
  /// Passe à `true` à l'arrêt du serveur : les flux SSE se terminent.
  pub shutdown: watch::Receiver<bool>,
}

type Shared = Arc<HttpState>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
  m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn router(state: Shared) -> Router {
  Router::new()
    .route("/api/v1/info", get(info))
    .route("/api/v1/call/{command}", post(call))
    .route("/api/v1/generate", post(generate))
    .route("/api/v1/events", get(events))
    .fallback(not_found)
    .layer(middleware::from_fn_with_state(state.clone(), authenticate))
    .layer(DefaultBodyLimit::max(BODY_LIMIT))
    .with_state(state)
}

pub fn error(status: StatusCode, message: impl Into<String>) -> Response {
  (status, Json(json!({ "error": message.into() }))).into_response()
}

/// Attend la demande d'arrêt (ou la disparition de son émetteur).
pub async fn wait_shutdown(rx: &mut watch::Receiver<bool>) {
  loop {
    if *rx.borrow_and_update() {
      return;
    }
    if rx.changed().await.is_err() {
      return;
    }
  }
}

fn sse(name: &str, data: &impl Serialize) -> Event {
  Event::default().event(name).data(serde_json::to_string(data).unwrap_or_else(|_| "null".into()))
}

/// Corps JSON d'un appel : objet (absent = objet vide).
fn parse_body(body: &Bytes) -> Result<Value, String> {
  if body.iter().all(u8::is_ascii_whitespace) {
    return Ok(Value::Object(Default::default()));
  }
  match serde_json::from_slice::<Value>(body) {
    Ok(v @ Value::Object(_)) => Ok(v),
    _ => Err("Corps invalide : objet JSON attendu.".into()),
  }
}

// ---------------------------------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------------------------------

async fn authenticate(State(st): State<Shared>, req: Request, next: Next) -> Response {
  let ip = req
    .extensions()
    .get::<ConnectInfo<SocketAddr>>()
    .map(|c| c.0.ip())
    .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
  let now = Instant::now();
  if lock(&st.limiter).blocked(ip, now) {
    return error(StatusCode::TOO_MANY_REQUESTS, TOO_MANY);
  }
  let stored = *st.keys.read().unwrap_or_else(|e| e.into_inner());
  let ok = req
    .headers()
    .get(AUTHORIZATION)
    .and_then(|v| v.to_str().ok())
    .and_then(auth::bearer)
    .is_some_and(|k| auth::verify(k, stored.as_ref()));
  if !ok {
    if lock(&st.limiter).fail(ip, now) {
      super::log(&format!("trop d'échecs d'authentification : {ip} bloquée"));
    }
    return error(StatusCode::UNAUTHORIZED, KEY_REFUSED);
  }
  lock(&st.limiter).success(ip);
  next.run(req).await
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

async fn not_found() -> Response {
  error(StatusCode::NOT_FOUND, "Route inconnue.")
}

async fn info(State(st): State<Shared>) -> Response {
  match st.backend.info().await {
    Ok(v) => Json(v).into_response(),
    Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, e),
  }
}

async fn call(State(st): State<Shared>, Path(command): Path<String>, body: Bytes) -> Response {
  if !calls::is_relayed(&command) {
    return error(StatusCode::NOT_FOUND, CallError::not_found(&command).message);
  }
  let args = match parse_body(&body) {
    Ok(v) => v,
    Err(e) => return error(StatusCode::BAD_REQUEST, e),
  };
  match st.backend.call(command, args).await {
    Ok(v) => Json(v).into_response(),
    Err(e) => error(StatusCode::from_u16(e.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), e.message),
  }
}

fn channel_stream(rx: mpsc::Receiver<Event>) -> impl futures_util::Stream<Item = Result<Event, Infallible>> {
  stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|ev| (Ok(ev), rx)) })
}

/// Génération en flux : `token` (jetons de cette requête seulement), puis `done` ou `error`.
/// Client parti avant la fin : la génération est arrêtée.
async fn generate(State(st): State<Shared>, body: Bytes) -> Response {
  let args = match parse_body(&body) {
    Ok(v) => v,
    Err(e) => return error(StatusCode::BAD_REQUEST, e),
  };
  let Some(request_id) = args.get("requestId").and_then(Value::as_str).map(str::to_owned) else {
    return error(StatusCode::BAD_REQUEST, "Arguments invalides pour engine_generate : requestId manquant.");
  };
  // Abonnement avant le démarrage : aucun jeton perdu.
  let mut events = bus::subscribe();
  let (tx, rx) = mpsc::channel::<Event>(256);
  let backend = st.backend.clone();
  let mut shutdown = st.shutdown.clone();

  tokio::spawn(async move {
    let mut job = backend.call("engine_generate".into(), args);
    let mut bus_open = true;
    let outcome = loop {
      tokio::select! {
        r = &mut job => break Some(r),
        ev = events.recv(), if bus_open => match ev {
          Ok(BusEvent::Token(t)) if t.request_id == request_id => {
            if tx.send(sse("token", &json!({ "text": t.text }))).await.is_err() {
              break None;
            }
          }
          Ok(_) | Err(RecvError::Lagged(_)) => {}
          Err(RecvError::Closed) => bus_open = false,
        },
        _ = tx.closed() => break None,
        _ = wait_shutdown(&mut shutdown) => break None,
      }
    };
    match outcome {
      Some(r) => {
        // Jetons encore dans le tampon du bus.
        loop {
          match events.try_recv() {
            Ok(BusEvent::Token(t)) if t.request_id == request_id => {
              let _ = tx.send(sse("token", &json!({ "text": t.text }))).await;
            }
            Ok(_) | Err(TryRecvError::Lagged(_)) => {}
            Err(_) => break,
          }
        }
        let last = match r {
          Ok(v) => sse("done", &v),
          Err(e) => sse("error", &json!({ "error": e.message })),
        };
        let _ = tx.send(last).await;
      }
      None => {
        // Client parti ou serveur arrêté : la génération peut ne pas avoir encore démarré
        // (chargement du modèle), on redemande l'arrêt jusqu'à sa fin.
        drop(tx);
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        loop {
          tokio::select! {
            _ = &mut job => break,
            _ = tick.tick() => backend.stop(&request_id),
          }
        }
      }
    }
  });

  Sse::new(channel_stream(rx)).keep_alive(KeepAlive::new().interval(KEEPALIVE)).into_response()
}

fn bus_event(ev: &BusEvent) -> Option<Event> {
  match ev {
    BusEvent::Status(s) => Some(sse("status", s)),
    BusEvent::Download(d) => Some(sse("download", d)),
    BusEvent::Removed(id) => Some(sse("download-removed", &json!({ "id": id }))),
    BusEvent::Token(_) => None,
  }
}

/// Flux des événements : statut du moteur (dès la connexion) et téléchargements.
async fn events(State(st): State<Shared>) -> Response {
  let rx = bus::subscribe();
  let first = sse("status", &st.backend.status());
  let rest = stream::unfold((rx, st.shutdown.clone()), |(mut rx, mut shutdown)| async move {
    loop {
      tokio::select! {
        _ = wait_shutdown(&mut shutdown) => return None,
        r = rx.recv() => match r {
          Ok(ev) => {
            if let Some(e) = bus_event(&ev) {
              return Some((Ok(e), (rx, shutdown)));
            }
          }
          Err(RecvError::Lagged(_)) => {}
          Err(RecvError::Closed) => return None,
        },
      }
    }
  });
  let stream = stream::once(async move { Ok::<_, Infallible>(first) }).chain(rest);
  Sse::new(stream).keep_alive(KeepAlive::new().interval(KEEPALIVE)).into_response()
}

#[cfg(test)]
mod tests {
  use super::*;
  use axum::body::{Body, to_bytes};
  use axum::http::Request as HttpRequest;
  use tower::ServiceExt;

  struct Fake;

  impl Backend for Fake {
    fn info(&self) -> BoxFuture<'static, Result<Value, String>> {
      Box::pin(async { Ok(json!({ "app": "lucania", "version": "test", "backend": "cpu", "gpuName": null, "vramBytes": null, "status": {} })) })
    }
    fn status(&self) -> Value {
      json!({ "loadedModel": null, "loading": false, "generating": false })
    }
    fn call(&self, name: String, args: Value) -> BoxFuture<'static, Result<Value, CallError>> {
      Box::pin(async move {
        match name.as_str() {
          "engine_status" => Ok(json!({ "loadedModel": "m", "args": args })),
          "engine_load" => Err(CallError { kind: crate::calls::ErrorKind::Failed, message: "Modèle introuvable.".into() }),
          "engine_generate" => {
            let id = args["requestId"].as_str().unwrap_or_default().to_string();
            for text in ["Bon", "jour"] {
              bus::publish(BusEvent::Token(crate::engine::TokenEvent { request_id: id.clone(), text: text.into() }));
              // Un jeton d'une autre requête : jamais transmis.
              bus::publish(BusEvent::Token(crate::engine::TokenEvent { request_id: "autre".into(), text: "X".into() }));
            }
            Ok(json!({ "content": "Bonjour", "tokens": 2, "stopReason": "eos" }))
          }
          _ => Err(CallError::not_found(&name)),
        }
      })
    }
    fn stop(&self, _request_id: &str) {}
  }

  const KEY: &str = "luc_test";

  fn app() -> (Router, watch::Sender<bool>) {
    let (tx, rx) = watch::channel(false);
    let state = Arc::new(HttpState {
      backend: Arc::new(Fake),
      keys: Arc::new(RwLock::new(Some(auth::hash_key(KEY)))),
      limiter: Arc::new(Mutex::new(Limiter::default())),
      shutdown: rx,
    });
    (router(state), tx)
  }

  fn req(method: &str, uri: &str, key: Option<&str>, ip: [u8; 4], body: &str) -> HttpRequest<Body> {
    let mut b = HttpRequest::builder().method(method).uri(uri);
    if let Some(k) = key {
      b = b.header("Authorization", format!("Bearer {k}"));
    }
    let mut r = b.body(Body::from(body.to_string())).unwrap();
    r.extensions_mut().insert(ConnectInfo(SocketAddr::from((ip, 50000))));
    r
  }

  async fn send(app: &Router, r: HttpRequest<Body>) -> (StatusCode, String) {
    let resp = app.clone().oneshot(r).await.unwrap();
    let status = resp.status();
    assert!(resp.headers().get("access-control-allow-origin").is_none());
    let body = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    (status, String::from_utf8_lossy(&body).into_owned())
  }

  #[tokio::test]
  async fn authentification_et_routes() {
    let (app, _sd) = app();
    let ip = [10, 0, 0, 7];
    // Sans clé, mauvaise clé : 401 JSON.
    let (s, b) = send(&app, req("GET", "/api/v1/info", None, ip, "")).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(serde_json::from_str::<Value>(&b).unwrap()["error"], KEY_REFUSED);
    let (s, _) = send(&app, req("GET", "/api/v1/info", Some("luc_faux"), ip, "")).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    // Bonne clé.
    let (s, b) = send(&app, req("GET", "/api/v1/info", Some(KEY), ip, "")).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(serde_json::from_str::<Value>(&b).unwrap()["app"], "lucania");
    // Commande inconnue ou hors liste blanche : 404 (après authentification seulement).
    let (s, _) = send(&app, req("POST", "/api/v1/call/uninstall_app", None, [10, 0, 0, 8], "{}")).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    for cmd in ["uninstall_app", "engine_generate", "hf_avatars", "inconnue"] {
      let (s, b) = send(&app, req("POST", &format!("/api/v1/call/{cmd}"), Some(KEY), ip, "{}")).await;
      assert_eq!(s, StatusCode::NOT_FOUND, "{cmd}");
      assert!(b.contains("Commande inconnue"));
    }
    let (s, _) = send(&app, req("GET", "/api/v1/rien", Some(KEY), ip, "")).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    // Appel valide : arguments transmis tels quels ; corps vide = objet vide.
    let (s, b) = send(&app, req("POST", "/api/v1/call/engine_status", Some(KEY), ip, r#"{"modelId":"x"}"#)).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(serde_json::from_str::<Value>(&b).unwrap()["args"]["modelId"], "x");
    let (s, _) = send(&app, req("POST", "/api/v1/call/engine_status", Some(KEY), ip, "")).await;
    assert_eq!(s, StatusCode::OK);
    // Corps invalide : 400 ; échec de la commande : 422 avec le message.
    let (s, _) = send(&app, req("POST", "/api/v1/call/engine_status", Some(KEY), ip, "[1]")).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, b) = send(&app, req("POST", "/api/v1/call/engine_load", Some(KEY), ip, "{}")).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(b.contains("Modèle introuvable."));
    // Corps trop gros.
    let big = format!(r#"{{"x":"{}"}}"#, "a".repeat(BODY_LIMIT + 10));
    let (s, _) = send(&app, req("POST", "/api/v1/call/engine_status", Some(KEY), ip, &big)).await;
    assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);
  }

  #[tokio::test]
  async fn blocage_429() {
    let (app, _sd) = app();
    let ip = [10, 0, 0, 9];
    for _ in 0..5 {
      let (s, _) = send(&app, req("GET", "/api/v1/info", Some("luc_faux"), ip, "")).await;
      assert_eq!(s, StatusCode::UNAUTHORIZED);
    }
    // Bloquée, même avec la bonne clé.
    let (s, b) = send(&app, req("GET", "/api/v1/info", Some(KEY), ip, "")).await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    assert!(b.contains(TOO_MANY));
    // Une autre IP n'est pas touchée.
    let (s, _) = send(&app, req("GET", "/api/v1/info", Some(KEY), [10, 0, 0, 10], "")).await;
    assert_eq!(s, StatusCode::OK);
  }

  #[tokio::test]
  async fn generation_en_flux() {
    let (app, _sd) = app();
    let (s, b) = send(&app, req("POST", "/api/v1/generate", Some(KEY), [10, 0, 0, 11], r#"{"requestId":"r1","modelId":"m","messages":[]}"#)).await;
    assert_eq!(s, StatusCode::OK);
    let mut parser = crate::remote::sse::SseParser::default();
    let evs = parser.push(b.as_bytes());
    let names: Vec<&str> = evs.iter().map(|e| e.event.as_str()).collect();
    assert_eq!(names, ["token", "token", "done"]);
    assert_eq!(evs[0].data, r#"{"text":"Bon"}"#);
    assert_eq!(serde_json::from_str::<Value>(&evs[2].data).unwrap()["content"], "Bonjour");
    // requestId absent : 400.
    let (s, _) = send(&app, req("POST", "/api/v1/generate", Some(KEY), [10, 0, 0, 11], "{}")).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
  }

  #[tokio::test]
  async fn evenements_et_arret() {
    let (app, sd) = app();
    let resp = app.clone().oneshot(req("GET", "/api/v1/events", Some(KEY), [10, 0, 0, 12], "")).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    // L'arrêt du serveur ferme le flux : le corps se termine.
    sd.send_replace(true);
    let body = tokio::time::timeout(Duration::from_secs(5), to_bytes(resp.into_body(), 1 << 20)).await.unwrap().unwrap();
    let evs = crate::remote::sse::SseParser::default().push(&body);
    assert_eq!(evs[0].event, "status");
    assert_eq!(serde_json::from_str::<Value>(&evs[0].data).unwrap()["generating"], false);
  }
}
