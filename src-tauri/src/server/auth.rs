//! Clé d'API de la tour : génération, empreinte SHA-256, comparaison en temps constant et
//! limite de débit sur les échecs d'authentification.

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

pub type KeyHash = [u8; 32];

pub const KEY_PREFIX: &str = "luc_";

/// Nouvelle clé : 32 octets aléatoires, base64url sans remplissage, préfixe `luc_`.
pub fn generate_key() -> Result<String, String> {
  let mut bytes = [0u8; 32];
  getrandom::fill(&mut bytes).map_err(|e| format!("Générateur aléatoire indisponible : {e}"))?;
  Ok(format!("{KEY_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes)))
}

pub fn hash_key(key: &str) -> KeyHash {
  Sha256::digest(key.as_bytes()).into()
}

/// Égalité en temps constant (XOR cumulé, sans sortie anticipée).
pub fn hash_eq(a: &KeyHash, b: &KeyHash) -> bool {
  let diff = a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y));
  std::hint::black_box(diff) == 0
}

/// Vérifie une clé présentée contre l'empreinte enregistrée (aucune clé : toujours refusé).
pub fn verify(presented: &str, stored: Option<&KeyHash>) -> bool {
  let h = hash_key(presented);
  stored.is_some_and(|s| hash_eq(&h, s))
}

pub fn to_hex(h: &KeyHash) -> String {
  h.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn from_hex(s: &str) -> Option<KeyHash> {
  let s = s.trim();
  if s.len() != 64 || !s.is_ascii() {
    return None;
  }
  let mut out = [0u8; 32];
  for (i, byte) in out.iter_mut().enumerate() {
    *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
  }
  Some(out)
}

/// Valeur d'un en-tête `Authorization: Bearer <clé>`.
pub fn bearer(header: &str) -> Option<&str> {
  let (scheme, rest) = header.trim().split_once(' ')?;
  let key = rest.trim();
  (scheme.eq_ignore_ascii_case("bearer") && !key.is_empty()).then_some(key)
}

// ---------------------------------------------------------------------------------------------
// Limite de débit
// ---------------------------------------------------------------------------------------------

/// Par IP : 5 échecs en 60 s bloquent cette IP 5 min.
const IP_MAX_FAILS: usize = 5;
const IP_WINDOW: Duration = Duration::from_secs(60);
const IP_BLOCK: Duration = Duration::from_secs(300);
/// Toutes IP confondues : 50 échecs en 60 s bloquent tout le monde 1 min.
const GLOBAL_MAX_FAILS: u32 = 50;
const GLOBAL_WINDOW: Duration = Duration::from_secs(60);
const GLOBAL_BLOCK: Duration = Duration::from_secs(60);
/// Mémoire bornée : au-delà, les nouvelles IP ne sont plus suivies (le plafond global reste).
const MAX_TRACKED: usize = 1024;

#[derive(Default)]
struct IpEntry {
  fails: VecDeque<Instant>,
  blocked_until: Option<Instant>,
}

impl IpEntry {
  fn idle(&self, now: Instant) -> bool {
    self.blocked_until.is_none_or(|t| t <= now) && self.fails.back().is_none_or(|&t| now.duration_since(t) >= IP_WINDOW)
  }
}

#[derive(Default)]
pub struct Limiter {
  ips: HashMap<IpAddr, IpEntry>,
  window_start: Option<Instant>,
  window_fails: u32,
  global_blocked_until: Option<Instant>,
}

impl Limiter {
  /// Vrai si cette IP (ou tout le monde) est bloquée : réponse 429, même avec la bonne clé.
  pub fn blocked(&self, ip: IpAddr, now: Instant) -> bool {
    self.global_blocked_until.is_some_and(|t| now < t) || self.ips.get(&ip).and_then(|e| e.blocked_until).is_some_and(|t| now < t)
  }

  /// Enregistre un échec d'authentification ; vrai si cet échec déclenche un blocage (de
  /// l'IP ou global), pour le journaliser une seule fois.
  pub fn fail(&mut self, ip: IpAddr, now: Instant) -> bool {
    let mut newly_blocked = false;
    // Plafond global (fenêtre fixe).
    if self.window_start.is_none_or(|s| now.duration_since(s) >= GLOBAL_WINDOW) {
      self.window_start = Some(now);
      self.window_fails = 0;
    }
    self.window_fails += 1;
    if self.window_fails >= GLOBAL_MAX_FAILS {
      self.global_blocked_until = Some(now + GLOBAL_BLOCK);
      self.window_fails = 0;
      newly_blocked = true;
    }

    // Par IP (fenêtre glissante).
    if !self.ips.contains_key(&ip) && self.ips.len() >= MAX_TRACKED {
      self.ips.retain(|_, e| !e.idle(now));
      if self.ips.len() >= MAX_TRACKED {
        return newly_blocked;
      }
    }
    let entry = self.ips.entry(ip).or_default();
    while entry.fails.front().is_some_and(|&t| now.duration_since(t) >= IP_WINDOW) {
      entry.fails.pop_front();
    }
    entry.fails.push_back(now);
    if entry.fails.len() >= IP_MAX_FAILS {
      entry.blocked_until = Some(now + IP_BLOCK);
      entry.fails.clear();
      newly_blocked = true;
    }
    newly_blocked
  }

  /// Authentification réussie : oublie les échecs de cette IP.
  pub fn success(&mut self, ip: IpAddr) {
    self.ips.remove(&ip);
  }

  #[cfg(test)]
  fn tracked(&self) -> usize {
    self.ips.len()
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::net::Ipv4Addr;

  fn ip(n: u32) -> IpAddr {
    IpAddr::V4(Ipv4Addr::from(0x0A00_0000 + n))
  }

  #[test]
  fn cle_generee() {
    let k = generate_key().unwrap();
    assert!(k.starts_with(KEY_PREFIX));
    // 32 octets en base64 sans remplissage : 43 caractères.
    assert_eq!(k.len(), KEY_PREFIX.len() + 43);
    assert!(k[4..].bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
    assert_ne!(k, generate_key().unwrap());
  }

  #[test]
  fn comparaison_de_cle() {
    let k = generate_key().unwrap();
    let h = hash_key(&k);
    assert!(verify(&k, Some(&h)));
    assert!(!verify(&format!("{k}x"), Some(&h)));
    assert!(!verify("", Some(&h)));
    assert!(!verify(&k, None));
    let mut other = h;
    other[31] ^= 1;
    assert!(!hash_eq(&h, &other));
    assert!(hash_eq(&h, &h.clone()));
    assert_eq!(from_hex(&to_hex(&h)), Some(h));
    assert_eq!(from_hex("zz"), None);
    assert_eq!(from_hex(&"é".repeat(32)), None);
  }

  #[test]
  fn en_tete_bearer() {
    assert_eq!(bearer("Bearer luc_abc"), Some("luc_abc"));
    assert_eq!(bearer("bearer   luc_abc "), Some("luc_abc"));
    assert_eq!(bearer("Basic xyz"), None);
    assert_eq!(bearer("Bearer "), None);
    assert_eq!(bearer("luc_abc"), None);
  }

  #[test]
  fn blocage_par_ip_et_expiration() {
    let mut l = Limiter::default();
    let t0 = Instant::now();
    for i in 0..4 {
      l.fail(ip(1), t0 + Duration::from_secs(i));
    }
    assert!(!l.blocked(ip(1), t0 + Duration::from_secs(5)));
    l.fail(ip(1), t0 + Duration::from_secs(5));
    assert!(l.blocked(ip(1), t0 + Duration::from_secs(6)));
    // Les autres IP ne sont pas touchées.
    assert!(!l.blocked(ip(2), t0 + Duration::from_secs(6)));
    // Fin du blocage après 5 min.
    assert!(l.blocked(ip(1), t0 + Duration::from_secs(304)));
    assert!(!l.blocked(ip(1), t0 + Duration::from_secs(306)));
  }

  #[test]
  fn fenetre_glissante() {
    let mut l = Limiter::default();
    let t0 = Instant::now();
    // 4 échecs, puis 4 autres plus d'une minute après : jamais 5 dans la même minute.
    for i in 0..4 {
      l.fail(ip(1), t0 + Duration::from_secs(i));
    }
    for i in 0..4 {
      l.fail(ip(1), t0 + Duration::from_secs(70 + i));
    }
    assert!(!l.blocked(ip(1), t0 + Duration::from_secs(75)));
    // Un succès remet le compteur à zéro.
    l.success(ip(1));
    l.fail(ip(1), t0 + Duration::from_secs(76));
    assert!(!l.blocked(ip(1), t0 + Duration::from_secs(77)));
  }

  #[test]
  fn plafond_global() {
    let mut l = Limiter::default();
    let t0 = Instant::now();
    // 50 IP différentes, une tentative chacune : plafond global atteint.
    for n in 0..49 {
      l.fail(ip(n), t0);
    }
    assert!(!l.blocked(ip(999), t0));
    l.fail(ip(49), t0);
    assert!(l.blocked(ip(999), t0 + Duration::from_secs(1)));
    assert!(!l.blocked(ip(999), t0 + Duration::from_secs(61)));
  }

  #[test]
  fn memoire_bornee() {
    let mut l = Limiter::default();
    let t0 = Instant::now();
    for n in 0..(MAX_TRACKED as u32 + 500) {
      // Une tentative par minute et par IP : jamais de plafond global, toutes « actives ».
      l.fail(ip(n), t0);
      l.window_fails = 0;
    }
    assert_eq!(l.tracked(), MAX_TRACKED);
    // Plus tard, les entrées inactives sont purgées pour faire de la place.
    l.fail(ip(5000), t0 + Duration::from_secs(120));
    assert_eq!(l.tracked(), 1);
  }
}
