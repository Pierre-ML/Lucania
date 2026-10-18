//! Logos des auteurs et organisations Hugging Face, renvoyés en data URL (base64).
//!
//! `GET /api/organizations/<nom>/avatar`, repli `GET /api/users/<nom>/avatar` : réponse JSON
//! `{ "avatarUrl": "https://cdn-avatars.huggingface.co/…" }`. L'image n'est téléchargée que
//! depuis huggingface.co, hf.co ou leurs sous-domaines, en HTTPS, sans jeton, 256 Ko au plus.
//!
//! Formats acceptés : PNG, JPEG, WebP et GIF, quand le type annoncé correspond au contenu réel
//! (signature des premiers octets). Le SVG est toujours refusé : c'est un document actif
//! (scripts, gestionnaires d'événements, liens `javascript:`, ressources externes via `<use>`,
//! `<image>` ou `url()` en CSS…) et un filtrage par mots-clés (« <script », « on…= ») se
//! contourne (entités, casse, espaces de noms). Le CDN de Hugging Face sert de toute façon les
//! logos en WebP ; un logo refusé donne `null` (la page affiche alors les initiales).
//!
//! Cache : mémoire, et disque `<app_local_data_dir>/hf-cache/avatars/<nom>.<ext>` valable
//! 7 jours. Un nom sans logo est retenu une heure en mémoire seulement.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use futures_util::StreamExt;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::{Client, StatusCode};
use serde::Deserialize;

use super::{Hf, api, lock, log};

/// Noms par appel.
pub const MAX_NAMES: usize = 30;
/// Requêtes simultanées.
const PARALLEL: usize = 6;
const MAX_BYTES: usize = 256 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);
const FRESH: Duration = Duration::from_secs(7 * 24 * 3600);
const NEGATIVE: Duration = Duration::from_secs(3600);
const MAX_MEMORY: usize = 1000;

/// Formats raster acceptés : (extension du cache, type MIME).
const FORMATS: [(&str, &str); 4] = [("png", "image/png"), ("jpg", "image/jpeg"), ("webp", "image/webp"), ("gif", "image/gif")];

#[derive(Default)]
pub(super) struct Cache {
  /// Nom en minuscules -> (date d'obtention, data URL ou absence de logo).
  mem: HashMap<String, (SystemTime, Option<String>)>,
}

/// Nom d'auteur ou d'organisation : `^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$`.
pub fn valid_name(name: &str) -> bool {
  let b = name.as_bytes();
  !b.is_empty() && b.len() <= 96 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// Nom de périphérique réservé par Windows (CON, NUL, COM1…), même suivi d'une extension : pas de
/// cache disque pour ces noms.
fn reserved_on_windows(stem: &str) -> bool {
  let s = stem.split('.').next().unwrap_or(stem).to_ascii_lowercase();
  matches!(s.as_str(), "con" | "prn" | "aux" | "nul")
    || ((s.starts_with("com") || s.starts_with("lpt")) && s.len() == 4 && s.as_bytes()[3].is_ascii_digit())
}

/// Format réel d'une image d'après ses premiers octets (formats raster acceptés seulement).
fn sniff(b: &[u8]) -> Option<(&'static str, &'static str)> {
  if b.starts_with(b"\x89PNG\r\n\x1a\n") {
    Some(FORMATS[0])
  } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
    Some(FORMATS[1])
  } else if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
    Some(FORMATS[2])
  } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
    Some(FORMATS[3])
  } else {
    None
  }
}

/// (extension, type MIME) si le type annoncé est un format accepté ET correspond au contenu.
/// SVG toujours refusé (voir l'en-tête du module).
fn accepted_image(content_type: &str, bytes: &[u8]) -> Option<(&'static str, &'static str)> {
  let declared = content_type.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
  let declared = if declared == "image/jpg" { "image/jpeg".to_string() } else { declared };
  sniff(bytes).filter(|(_, mime)| *mime == declared)
}

fn base64(data: &[u8]) -> String {
  const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
  for c in data.chunks(3) {
    let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
    out.push(T[(n >> 18) as usize & 63] as char);
    out.push(T[(n >> 12) as usize & 63] as char);
    out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
    out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
  }
  out
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
  format!("data:{mime};base64,{}", base64(bytes))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAvatar {
  avatar_url: Option<String>,
}

/// Image (extension, type MIME, octets) du logo de `name` ; `None` : pas de logo utilisable.
async fn fetch(client: &Client, name: &str) -> Result<Option<(&'static str, &'static str, Vec<u8>)>, String> {
  let mut avatar = None;
  for kind in ["organizations", "users"] {
    let url = api::hf_url(&["api", kind, name, "avatar"])?;
    let resp = client.get(url).timeout(TIMEOUT).send().await.map_err(api::net_error)?;
    match resp.status() {
      s if s.is_success() => {
        let raw: RawAvatar = resp.json().await.map_err(|_| "Réponse de Hugging Face illisible.".to_string())?;
        avatar = raw.avatar_url;
        break;
      }
      StatusCode::NOT_FOUND => continue,
      s => return Err(api::status_error(s, "Logo introuvable.")),
    }
  }
  let Some(raw) = avatar else { return Ok(None) };
  // URL absolue, ou relative à huggingface.co.
  let Ok(url) = api::hf_url(&[]).and_then(|base| base.join(&raw).map_err(|e| e.to_string())) else {
    return Ok(None);
  };
  if !api::allowed_host(&url) {
    log(&format!("logo de « {name} » ignoré : hôte non autorisé ({})", url.host_str().unwrap_or("?")));
    return Ok(None);
  }
  let resp = client
    .get(url)
    .header(ACCEPT, "image/webp,image/png,image/jpeg,image/gif")
    .timeout(TIMEOUT)
    .send()
    .await
    .map_err(api::net_error)?;
  let status = resp.status();
  if status == StatusCode::NOT_FOUND {
    return Ok(None);
  }
  if !status.is_success() {
    return Err(api::status_error(status, "Logo introuvable."));
  }
  let content_type = resp.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
  if resp.content_length().is_some_and(|n| n > MAX_BYTES as u64) {
    return Ok(None);
  }
  let mut bytes = Vec::new();
  let mut stream = resp.bytes_stream();
  while let Some(chunk) = stream.next().await {
    let chunk = chunk.map_err(api::net_error)?;
    if bytes.len() + chunk.len() > MAX_BYTES {
      return Ok(None);
    }
    bytes.extend_from_slice(&chunk);
  }
  Ok(accepted_image(&content_type, &bytes).map(|(ext, mime)| (ext, mime, bytes)))
}

/// Logo en cache disque : (âge, data URL).
async fn read_disk(dir: &Path, key: &str) -> Option<(Duration, String)> {
  for (ext, mime) in FORMATS {
    let path = dir.join(format!("{key}.{ext}"));
    let Ok(meta) = tokio::fs::metadata(&path).await else { continue };
    if !meta.is_file() || meta.len() > MAX_BYTES as u64 {
      continue;
    }
    let age = meta.modified().ok().and_then(|m| m.elapsed().ok()).unwrap_or(Duration::MAX);
    let Ok(bytes) = tokio::fs::read(&path).await else { continue };
    if sniff(&bytes).is_some_and(|(_, m)| m == mime) {
      return Some((age, data_url(mime, &bytes)));
    }
  }
  None
}

async fn write_disk(dir: &Path, key: &str, ext: &str, bytes: &[u8]) {
  let written = async {
    tokio::fs::create_dir_all(dir).await?;
    for (other, _) in FORMATS {
      if other != ext {
        let _ = tokio::fs::remove_file(dir.join(format!("{key}.{other}"))).await;
      }
    }
    let tmp = dir.join(format!("{key}.{ext}.tmp"));
    tokio::fs::write(&tmp, bytes).await?;
    tokio::fs::rename(&tmp, dir.join(format!("{key}.{ext}"))).await
  };
  if let Err(e) = written.await {
    log(&format!("logo de « {key} » non enregistré : {e}"));
  }
}

fn remember(hf: &Hf, key: &str, at: SystemTime, value: Option<String>) {
  let mut cache = lock(&hf.inner.avatars);
  if cache.mem.len() >= MAX_MEMORY {
    cache.mem.clear();
  }
  cache.mem.insert(key.to_string(), (at, value));
}

/// Logo d'un nom valide (data URL) ou `None`.
async fn one(hf: &Hf, client: &Client, dir: &Path, name: &str) -> Option<String> {
  let key = name.to_ascii_lowercase();
  if let Some((at, value)) = lock(&hf.inner.avatars).mem.get(&key).cloned() {
    let ttl = if value.is_some() { FRESH } else { NEGATIVE };
    if at.elapsed().is_ok_and(|age| age < ttl) {
      return value;
    }
  }
  let use_disk = !reserved_on_windows(&key);
  let mut stale = None;
  if use_disk {
    if let Some((age, url)) = read_disk(dir, &key).await {
      if age < FRESH {
        remember(hf, &key, SystemTime::now().checked_sub(age).unwrap_or_else(SystemTime::now), Some(url.clone()));
        return Some(url);
      }
      stale = Some(url);
    }
  }
  match fetch(client, name).await {
    Ok(Some((ext, mime, bytes))) => {
      if use_disk {
        write_disk(dir, &key, ext, &bytes).await;
      }
      let url = data_url(mime, &bytes);
      remember(hf, &key, SystemTime::now(), Some(url.clone()));
      Some(url)
    }
    Ok(None) => {
      remember(hf, &key, SystemTime::now(), None);
      None
    }
    Err(e) => {
      // Échec réseau : non mis en cache ; ancien logo s'il existe.
      log(&format!("logo de « {name} » indisponible : {e}"));
      stale
    }
  }
}

/// Logos de `names` (30 au plus) : data URL, ou null si le nom est invalide ou sans logo
/// utilisable.
pub(super) async fn avatars(hf: &Hf, names: Vec<String>) -> Result<HashMap<String, Option<String>>, String> {
  if names.len() > MAX_NAMES {
    return Err(format!("{MAX_NAMES} noms au plus par appel."));
  }
  let client = hf.client()?;
  let dir: PathBuf = hf.inner.cache_dir.join("avatars");
  let mut out: HashMap<String, Option<String>> = HashMap::new();
  let mut wanted = Vec::new();
  for n in names {
    if out.contains_key(&n) {
      continue;
    }
    if valid_name(&n) {
      wanted.push(n.clone());
    }
    out.insert(n, None);
  }
  let found: Vec<(String, Option<String>)> = futures_util::stream::iter(wanted)
    .map(|n| {
      let (hf, client, dir) = (hf.clone(), client.clone(), dir.clone());
      async move {
        let v = one(&hf, &client, &dir, &n).await;
        (n, v)
      }
    })
    .buffer_unordered(PARALLEL)
    .collect()
    .await;
  out.extend(found);
  Ok(out)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn noms_valides() {
    for ok in ["Qwen", "unsloth", "meta-llama", "deepseek-ai", "a", "x.y_z-1", &"a".repeat(96)] {
      assert!(valid_name(ok), "{ok}");
    }
    for bad in ["", "-a", ".a", "_a", "a/b", "a b", "a\\b", "../x", "a:b", "é", &"a".repeat(97)] {
      assert!(!valid_name(bad), "{bad}");
    }
    assert!(reserved_on_windows("con") && reserved_on_windows("nul.x") && reserved_on_windows("com1"));
    assert!(!reserved_on_windows("console") && !reserved_on_windows("qwen") && !reserved_on_windows("comx"));
  }

  #[test]
  fn svg_refuse() {
    let dangerous = br#"<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>"#;
    let benign = br#"<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>"#;
    for body in [&dangerous[..], &benign[..]] {
      assert_eq!(accepted_image("image/svg+xml", body), None);
      // SVG déguisé en PNG : le contenu ne correspond pas.
      assert_eq!(accepted_image("image/png", body), None);
    }
    // Contenu PNG annoncé comme SVG : refusé aussi.
    assert_eq!(accepted_image("image/svg+xml", b"\x89PNG\r\n\x1a\n...."), None);
  }

  #[test]
  fn formats_acceptes() {
    assert_eq!(accepted_image("image/png", b"\x89PNG\r\n\x1a\nxxxx"), Some(("png", "image/png")));
    assert_eq!(accepted_image("image/jpeg", &[0xFF, 0xD8, 0xFF, 0xE0]), Some(("jpg", "image/jpeg")));
    assert_eq!(accepted_image("IMAGE/JPG; charset=x", &[0xFF, 0xD8, 0xFF, 0xE0]), Some(("jpg", "image/jpeg")));
    assert_eq!(accepted_image("image/webp", b"RIFF\x10\0\0\0WEBPVP8 "), Some(("webp", "image/webp")));
    assert_eq!(accepted_image("image/gif", b"GIF89a.."), Some(("gif", "image/gif")));
    // Type annoncé différent du contenu, ou type non image.
    assert_eq!(accepted_image("image/png", b"GIF89a.."), None);
    assert_eq!(accepted_image("text/html", b"\x89PNG\r\n\x1a\n"), None);
    assert_eq!(accepted_image("", b""), None);
  }

  #[test]
  fn encodage_base64() {
    assert_eq!(base64(b""), "");
    assert_eq!(base64(b"f"), "Zg==");
    assert_eq!(base64(b"fo"), "Zm8=");
    assert_eq!(base64(b"foo"), "Zm9v");
    assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    assert_eq!(base64(&[0xFF, 0xFE, 0x00]), "//4A");
    assert_eq!(data_url("image/png", b"fo"), "data:image/png;base64,Zm8=");
  }

  /// Test réseau (ignoré par défaut) : cargo test --lib hf::avatars -- --ignored --nocapture
  #[test]
  #[ignore]
  fn logos_reels() {
    let root = std::env::temp_dir().join(format!("lucania-hf-avatars-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let hf = Hf::new(root.clone(), &root, "test", Box::new(|_| {}));
    let names: Vec<String> = ["Qwen", "unsloth", "meta-llama", "mistralai", "google", "microsoft", "deepseek-ai", "openai", "bartowski", "existe-pas-lucania-123456", "../x"]
      .iter()
      .map(|s| s.to_string())
      .collect();
    tauri::async_runtime::block_on(async {
      let start = std::time::Instant::now();
      let r = avatars(&hf, names.clone()).await.unwrap();
      eprintln!("1er appel : {:?}", start.elapsed());
      for n in &names {
        let v = &r[n];
        eprintln!("{n} : {}", v.as_ref().map(|u| format!("{} ({} car.)", &u[..u.find(',').unwrap_or(0)], u.len())).unwrap_or("null".into()));
      }
      assert!(names[..9].iter().all(|n| r[n].is_some()));
      assert!(r["existe-pas-lucania-123456"].is_none() && r["../x"].is_none());
      // Cache disque relu par une nouvelle instance, sans réseau pour les logos.
      let hf2 = Hf::new(root.clone(), &root, "test", Box::new(|_| {}));
      let start = std::time::Instant::now();
      let r2 = avatars(&hf2, names[..9].to_vec()).await.unwrap();
      eprintln!("2e appel (cache disque) : {:?}", start.elapsed());
      assert!(names[..9].iter().all(|n| r2[n] == r[n]));
      assert!(avatars(&hf, (0..31).map(|i| format!("n{i}")).collect()).await.is_err());
    });
    let _ = std::fs::remove_dir_all(&root);
  }
}
