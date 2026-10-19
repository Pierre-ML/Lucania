//! Découverte de la tour sur le réseau local (UDP) : le portable n'a que la clé à saisir.
//!
//! Protocole (JSON, un paquet par message, port `DISCOVERY_PORT`) :
//! - sonde du client : `{"lucania":"probe","v":1,"id":"<hex32>","nonce":"<base64url>"}` ;
//! - réponse de la tour (unicast, seulement si `id` correspond à sa clé et si le serveur tourne) :
//!   `{"lucania":"here","v":1,"name","ip","port","proof"}`.
//!
//! `id` = 32 premiers caractères hexadécimaux de SHA-256("lucania-discovery-id-v1" || empreinte
//! de la clé) : la tour ne répond qu'à qui connaît la clé, sans que la sonde la révèle.
//! `proof` = HMAC-SHA256(empreinte, "lucania-discovery-v1|nonce|ip|port") : prouve que la
//! réponse vient d'une machine qui connaît la clé (une machine du réseau qui a seulement
//! sniffé la sonde ne peut pas se faire passer pour la tour).

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::net::UdpSocket;
use tokio::sync::watch;
use tokio::time::Instant;

use super::auth::{self, KeyHash};
use super::http::wait_shutdown;
use super::log;

pub const DISCOVERY_PORT: u16 = 4751;

/// Au-delà, le paquet est ignoré sans réponse.
const MAX_PACKET: usize = 1024;
/// Nombre d'envois de la sonde et durée totale d'attente côté client.
const PROBE_SENDS: u32 = 3;
const PROBE_TOTAL: Duration = Duration::from_millis(2500);
/// Longueur maximale du nonce reçu (16 octets en base64url : 22 caractères).
const MAX_NONCE: usize = 64;
const MAX_NAME: usize = 64;
const ID_DOMAIN: &[u8] = b"lucania-discovery-id-v1";
const PROOF_DOMAIN: &str = "lucania-discovery-v1";

pub const ERR_NOT_FOUND: &str = "discovery_not_found";
pub const ERR_INVALID_KEY: &str = "discovery_invalid_key";

// ---------------------------------------------------------------------------------------------
// Messages et calculs communs
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct Probe {
  lucania: String,
  v: u32,
  id: String,
  nonce: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Here {
  lucania: String,
  v: u32,
  name: String,
  ip: String,
  port: u16,
  proof: String,
}

/// Identifiant public d'une clé (calculé depuis son empreinte).
pub fn discovery_id(key_hash: &KeyHash) -> String {
  let mut h = Sha256::new();
  h.update(ID_DOMAIN);
  h.update(key_hash);
  let digest: [u8; 32] = h.finalize().into();
  auth::to_hex(&digest)[..32].to_string()
}

/// HMAC-SHA256 (RFC 2104), écrit à la main pour ne pas ajouter de dépendance.
fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
  const BLOCK: usize = 64;
  let mut k = [0u8; BLOCK];
  if key.len() > BLOCK {
    k[..32].copy_from_slice(&Sha256::digest(key));
  } else {
    k[..key.len()].copy_from_slice(key);
  }
  let mut inner = Sha256::new();
  inner.update(k.map(|b| b ^ 0x36));
  inner.update(msg);
  let inner: [u8; 32] = inner.finalize().into();
  let mut outer = Sha256::new();
  outer.update(k.map(|b| b ^ 0x5c));
  outer.update(inner);
  outer.finalize().into()
}

/// Preuve attachée à une réponse (hexadécimal).
fn proof(key_hash: &KeyHash, nonce: &str, ip: &str, port: u16) -> KeyHash {
  hmac_sha256(key_hash, format!("{PROOF_DOMAIN}|{nonce}|{ip}|{port}").as_bytes())
}

/// Nonce de sonde acceptable : court, alphabet base64url (aucun séparateur `|`).
fn valid_nonce(nonce: &str) -> bool {
  !nonce.is_empty() && nonce.len() <= MAX_NONCE && nonce.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// Lit une sonde ; `None` si le paquet est trop gros, illisible ou d'un autre protocole.
fn parse_probe(data: &[u8]) -> Option<Probe> {
  if data.len() > MAX_PACKET {
    return None;
  }
  let p: Probe = serde_json::from_slice(data).ok()?;
  (p.lucania == "probe" && p.v == 1 && valid_nonce(&p.nonce)).then_some(p)
}

fn machine_name() -> String {
  std::env::var("COMPUTERNAME").ok().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| "Lucania".to_string())
}

/// Réponse à une sonde, ou `None` si l'identifiant ne correspond pas à la clé de la tour.
fn answer(data: &[u8], key_hash: &KeyHash, name: &str, listen: SocketAddr) -> Option<Vec<u8>> {
  let probe = parse_probe(data)?;
  if probe.id != discovery_id(key_hash) {
    return None;
  }
  let ip = if listen.ip().is_unspecified() { String::new() } else { listen.ip().to_string() };
  let here = Here {
    lucania: "here".into(),
    v: 1,
    name: name.to_string(),
    proof: auth::to_hex(&proof(key_hash, &probe.nonce, &ip, listen.port())),
    ip,
    port: listen.port(),
  };
  serde_json::to_vec(&here).ok()
}

// ---------------------------------------------------------------------------------------------
// Côté tour
// ---------------------------------------------------------------------------------------------

/// Écoute les sondes tant que le serveur tourne (`stop` passe à vrai à l'arrêt). Un échec de
/// liaison du port est journalisé : le serveur HTTP fonctionne quand même.
pub fn spawn_responder(
  keys: Arc<RwLock<Option<KeyHash>>>,
  listen: SocketAddr,
  mut stop: watch::Receiver<bool>,
) -> tauri::async_runtime::JoinHandle<()> {
  tauri::async_runtime::spawn(async move {
    let socket = match UdpSocket::bind((Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT)).await {
      Ok(s) => s,
      Err(e) => {
        log(&format!("découverte réseau indisponible (UDP {DISCOVERY_PORT}) : {e}"));
        return;
      }
    };
    let name = machine_name();
    // Un octet de plus que la limite : un paquet trop gros est reconnu sans être tronqué.
    let mut buf = [0u8; MAX_PACKET + 1];
    loop {
      let received = tokio::select! {
        _ = wait_shutdown(&mut stop) => break,
        r = socket.recv_from(&mut buf) => r,
      };
      let (n, src) = match received {
        Ok(v) => v,
        // Windows signale ainsi un ICMP « port inaccessible » d'un envoi précédent.
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => continue,
        Err(e) => {
          log(&format!("découverte réseau interrompue : {e}"));
          break;
        }
      };
      if n > MAX_PACKET {
        continue;
      }
      let key_hash = *keys.read().unwrap_or_else(|e| e.into_inner());
      let Some(key_hash) = key_hash else { continue };
      if let Some(reply) = answer(&buf[..n], &key_hash, &name, listen) {
        let _ = socket.send_to(&reply, src).await;
      }
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Côté portable
// ---------------------------------------------------------------------------------------------

/// Résultat de `remote_discover`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverResult {
  pub url: String,
  pub name: String,
  pub ip: String,
  pub port: u16,
}

/// Nom affichable : sans caractères de contrôle, borné.
fn clean_name(name: &str) -> String {
  name.chars().filter(|c| !c.is_control()).take(MAX_NAME).collect::<String>().trim().to_string()
}

/// Lit une réponse : proof vérifié en temps constant, sinon `None`. IP retenue : celle de la
/// réponse, à défaut l'adresse source du paquet.
fn parse_here(data: &[u8], src: IpAddr, key_hash: &KeyHash, nonce: &str) -> Option<DiscoverResult> {
  if data.len() > MAX_PACKET {
    return None;
  }
  let h: Here = serde_json::from_slice(data).ok()?;
  if h.lucania != "here" || h.v != 1 || h.port == 0 {
    return None;
  }
  if !h.ip.is_empty() && h.ip.parse::<Ipv4Addr>().is_err() {
    return None;
  }
  let given = auth::from_hex(&h.proof)?;
  if !auth::hash_eq(&given, &proof(key_hash, nonce, &h.ip, h.port)) {
    return None;
  }
  let ip = if h.ip.is_empty() { src.to_string() } else { h.ip };
  let name = clean_name(&h.name);
  Some(DiscoverResult { url: format!("http://{ip}:{}", h.port), name: if name.is_empty() { ip.clone() } else { name }, ip, port: h.port })
}

/// Adresse de broadcast dirigé du sous-réseau d'une interface.
fn directed_broadcast(ip: Ipv4Addr, netmask: Ipv4Addr) -> Ipv4Addr {
  Ipv4Addr::from(u32::from(ip) | !u32::from(netmask))
}

/// Envoie la sonde `PROBE_SENDS` fois vers `targets` et attend une réponse valide.
async fn probe(socket: &UdpSocket, key_hash: &KeyHash, targets: &[SocketAddr], total: Duration) -> Option<DiscoverResult> {
  let mut raw = [0u8; 16];
  getrandom::fill(&mut raw).ok()?;
  let nonce = URL_SAFE_NO_PAD.encode(raw);
  let message = serde_json::to_vec(&Probe { lucania: "probe".into(), v: 1, id: discovery_id(key_hash), nonce: nonce.clone() }).ok()?;

  let start = Instant::now();
  let mut buf = [0u8; MAX_PACKET + 1];
  for i in 1..=PROBE_SENDS {
    for t in targets {
      // Une cible injoignable (pas de broadcast sur cette interface) n'empêche pas les autres.
      let _ = socket.send_to(&message, t).await;
    }
    let until = start + total * i / PROBE_SENDS;
    loop {
      let r = tokio::time::timeout_at(until, socket.recv_from(&mut buf)).await;
      match r {
        Err(_) => break,
        Ok(Ok((n, src))) if n <= MAX_PACKET => {
          if let Some(found) = parse_here(&buf[..n], src.ip(), key_hash, &nonce) {
            return Some(found);
          }
        }
        Ok(Ok(_)) => {}
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionReset => {}
        Ok(Err(_)) => return None,
      }
    }
  }
  None
}

/// Cherche la tour dont la clé est `key` depuis l'interface `interface_ip` (broadcast UDP).
#[tauri::command]
pub async fn remote_discover(key: String, interface_ip: String) -> Result<DiscoverResult, String> {
  let key = key.trim();
  if key.is_empty() || !crate::remote::valid_key(key) {
    return Err(ERR_INVALID_KEY.into());
  }
  let ip: Ipv4Addr = interface_ip.trim().parse().map_err(|_| format!("Adresse d'interface invalide : « {} ».", interface_ip.trim()))?;

  let mut targets = vec![SocketAddr::from((Ipv4Addr::BROADCAST, DISCOVERY_PORT))];
  let mask = tauri::async_runtime::spawn_blocking(move || {
    if_addrs::get_if_addrs().ok().and_then(|list| {
      list.into_iter().find_map(|i| match i.addr {
        if_addrs::IfAddr::V4(v4) if v4.ip == ip => Some(v4.netmask),
        _ => None,
      })
    })
  })
  .await
  .map_err(|e| format!("Liste des interfaces interrompue : {e}"))?;
  if let Some(mask) = mask {
    let b = directed_broadcast(ip, mask);
    if b != Ipv4Addr::BROADCAST && b != ip {
      targets.push(SocketAddr::from((b, DISCOVERY_PORT)));
    }
  }

  let socket = UdpSocket::bind((ip, 0)).await.map_err(|e| format!("Recherche impossible depuis {ip} : {e}"))?;
  socket.set_broadcast(true).map_err(|e| format!("Recherche impossible depuis {ip} : {e}"))?;
  probe(&socket, &auth::hash_key(key), &targets, PROBE_TOTAL).await.ok_or_else(|| ERR_NOT_FOUND.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn hash(k: &str) -> KeyHash {
    auth::hash_key(k)
  }

  fn listen() -> SocketAddr {
    ([10, 0, 0, 2], 4750).into()
  }

  fn probe_for(k: &str, nonce: &str) -> Vec<u8> {
    serde_json::to_vec(&Probe { lucania: "probe".into(), v: 1, id: discovery_id(&hash(k)), nonce: nonce.into() }).unwrap()
  }

  #[test]
  fn hmac_vecteur_rfc_4231() {
    let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
    assert_eq!(auth::to_hex(&mac), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  }

  #[test]
  fn identifiant_stable() {
    let id = discovery_id(&hash("luc_abc"));
    assert_eq!(id.len(), 32);
    assert!(id.bytes().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(id, discovery_id(&hash("luc_abc")));
    assert_ne!(id, discovery_id(&hash("luc_abd")));
    // Le serveur le calcule depuis l'empreinte relue du fichier : même résultat.
    let stored = auth::from_hex(&auth::to_hex(&hash("luc_abc"))).unwrap();
    assert_eq!(id, discovery_id(&stored));
  }

  #[test]
  fn reponse_verifiee() {
    let h = hash("luc_abc");
    let reply = answer(&probe_for("luc_abc", "bm9uY2U"), &h, "TOUR", listen()).unwrap();
    let found = parse_here(&reply, [192, 168, 1, 9].into(), &h, "bm9uY2U").unwrap();
    assert_eq!(found, DiscoverResult { url: "http://10.0.0.2:4750".into(), name: "TOUR".into(), ip: "10.0.0.2".into(), port: 4750 });
    // Mauvais nonce (rejeu d'une ancienne réponse) ou mauvaise clé : refusé.
    assert!(parse_here(&reply, [192, 168, 1, 9].into(), &h, "autre").is_none());
    assert!(parse_here(&reply, [192, 168, 1, 9].into(), &hash("luc_xyz"), "bm9uY2U").is_none());
  }

  #[test]
  fn ecoute_sur_toutes_les_interfaces() {
    let h = hash("luc_abc");
    let all: SocketAddr = ([0, 0, 0, 0], 4750).into();
    let reply = answer(&probe_for("luc_abc", "n1"), &h, "TOUR", all).unwrap();
    // IP vide dans la réponse : l'adresse source du paquet est retenue.
    let found = parse_here(&reply, [192, 168, 1, 9].into(), &h, "n1").unwrap();
    assert_eq!((found.ip.as_str(), found.url.as_str()), ("192.168.1.9", "http://192.168.1.9:4750"));
  }

  #[test]
  fn proof_falsifie_rejete() {
    let h = hash("luc_abc");
    let reply = answer(&probe_for("luc_abc", "n1"), &h, "TOUR", listen()).unwrap();
    let mut v: serde_json::Value = serde_json::from_slice(&reply).unwrap();
    // Port modifié, preuve inchangée.
    v["port"] = 4999.into();
    assert!(parse_here(&serde_json::to_vec(&v).unwrap(), [10, 0, 0, 2].into(), &h, "n1").is_none());
    // IP modifiée.
    let mut v: serde_json::Value = serde_json::from_slice(&reply).unwrap();
    v["ip"] = "10.0.0.66".into();
    assert!(parse_here(&serde_json::to_vec(&v).unwrap(), [10, 0, 0, 2].into(), &h, "n1").is_none());
    // Preuve forgée par quelqu'un qui ne connaît pas la clé.
    let mut v: serde_json::Value = serde_json::from_slice(&reply).unwrap();
    let fake = auth::to_hex(&proof(&hash("luc_pirate"), "n1", "10.0.0.2", 4750));
    v["proof"] = fake.into();
    assert!(parse_here(&serde_json::to_vec(&v).unwrap(), [10, 0, 0, 2].into(), &h, "n1").is_none());
    v["proof"] = "zz".into();
    assert!(parse_here(&serde_json::to_vec(&v).unwrap(), [10, 0, 0, 2].into(), &h, "n1").is_none());
  }

  #[test]
  fn sonde_invalide_ignoree() {
    let h = hash("luc_abc");
    // Mauvaise clé : aucune réponse.
    assert!(answer(&probe_for("luc_autre", "n1"), &h, "T", listen()).is_none());
    for bad in [
      &b""[..],
      b"pas du json",
      b"{}",
      br#"{"lucania":"here","v":1,"id":"x","nonce":"n1"}"#,
      br#"{"lucania":"probe","v":2,"id":"x","nonce":"n1"}"#,
      br#"{"lucania":"probe","v":1,"id":"x"}"#,
    ] {
      assert!(parse_probe(bad).is_none());
      assert!(answer(bad, &h, "T", listen()).is_none());
    }
    // Nonce avec séparateur ou trop long ; paquet trop gros.
    assert!(answer(&probe_for("luc_abc", "a|b"), &h, "T", listen()).is_none());
    assert!(answer(&probe_for("luc_abc", &"a".repeat(MAX_NONCE + 1)), &h, "T", listen()).is_none());
    assert!(parse_probe(&vec![b' '; MAX_PACKET + 1]).is_none());
  }

  #[test]
  fn broadcast_dirige() {
    assert_eq!(directed_broadcast([192, 168, 1, 20].into(), [255, 255, 255, 0].into()), Ipv4Addr::new(192, 168, 1, 255));
    assert_eq!(directed_broadcast([10, 1, 2, 3].into(), [255, 255, 0, 0].into()), Ipv4Addr::new(10, 1, 255, 255));
  }

  /// Tour et portable sur la boucle locale (port éphémère à la place du port 4751).
  #[tokio::test]
  async fn decouverte_de_bout_en_bout() {
    let key = "luc_test-decouverte";
    let h = hash(key);
    let tower = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let tower_addr = tower.local_addr().unwrap();
    let listen: SocketAddr = ([127, 0, 0, 1], 4750).into();
    let served = tokio::spawn(async move {
      let mut buf = [0u8; 2048];
      loop {
        let (n, src) = tower.recv_from(&mut buf).await.unwrap();
        if let Some(reply) = answer(&buf[..n], &h, "TOUR", listen) {
          tower.send_to(&reply, src).await.unwrap();
        }
      }
    });
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let found = probe(&client, &hash(key), &[tower_addr], Duration::from_millis(900)).await.unwrap();
    assert_eq!((found.url.as_str(), found.name.as_str()), ("http://127.0.0.1:4750", "TOUR"));
    // Une autre clé : la tour reste muette.
    assert!(probe(&client, &hash("luc_autre"), &[tower_addr], Duration::from_millis(300)).await.is_none());
    served.abort();
  }
}
