//! Appels HTTP vers Hugging Face. Toutes les URL sont construites à partir de
//! https://huggingface.co ; les redirections (CDN des gros fichiers) ne sont suivies que vers
//! huggingface.co, hf.co et leurs sous-domaines, en HTTPS. Le jeton n'est jamais journalisé et
//! reqwest retire l'en-tête Authorization dès qu'une redirection change d'hôte
//! (`redirect::remove_sensitive_headers`).

use std::time::Duration;

use reqwest::header::{AUTHORIZATION, HeaderValue, LINK};
use reqwest::redirect::Policy;
use reqwest::{Client, RequestBuilder, StatusCode, Url};
use serde::Deserialize;

use super::types::SearchResult;

const BASE: &str = "https://huggingface.co";
/// Délai maximal d'un appel d'API (pas des téléchargements, limités par `read_timeout`).
const API_TIMEOUT: Duration = Duration::from_secs(30);
/// Garde-fou contre une pagination sans fin.
const MAX_PAGES: usize = 50;

pub const ACCESS_DENIED: &str =
  "Accès refusé : ce modèle demande un jeton Hugging Face et l'acceptation de sa licence sur huggingface.co.";
pub const FILE_NOT_FOUND: &str = "Fichier introuvable sur Hugging Face.";
pub const REPO_NOT_FOUND: &str = "Dépôt introuvable sur Hugging Face (nom erroné ou dépôt privé).";
pub const TOKEN_REFUSED: &str = "Jeton Hugging Face refusé.";

pub fn allowed_host(url: &Url) -> bool {
  url.scheme() == "https"
    && url.host_str().is_some_and(|h| {
      let h = h.to_ascii_lowercase();
      h == "huggingface.co" || h.ends_with(".huggingface.co") || h == "hf.co" || h.ends_with(".hf.co")
    })
}

pub fn build_client(version: &str) -> Result<Client, String> {
  Client::builder()
    .user_agent(format!("Lucania/{version}"))
    .https_only(true)
    .connect_timeout(Duration::from_secs(20))
    // Délai entre deux lectures : détecte une connexion figée sans limiter la durée totale.
    .read_timeout(Duration::from_secs(60))
    .redirect(Policy::custom(|attempt| {
      if attempt.previous().len() >= 10 {
        attempt.error("trop de redirections")
      } else if !allowed_host(attempt.url()) {
        attempt.error("redirection vers un hôte non autorisé")
      } else {
        attempt.follow()
      }
    }))
    .build()
    .map_err(|e| format!("Client HTTP indisponible : {e}"))
}

/// URL https://huggingface.co/<segments…>, chaque segment encodé séparément.
pub fn hf_url(segments: &[&str]) -> Result<Url, String> {
  let mut url = Url::parse(BASE).map_err(|e| format!("URL invalide : {e}"))?;
  url.path_segments_mut().map_err(|_| "URL invalide".to_string())?.extend(segments);
  Ok(url)
}

/// URL de téléchargement d'un fichier : /<org>/<nom>/resolve/main/<chemin>.
pub fn resolve_url(repo: &str, file: &str) -> Result<Url, String> {
  let mut segments: Vec<&str> = repo.split('/').collect();
  segments.extend(["resolve", "main"]);
  segments.extend(file.split('/'));
  hf_url(&segments)
}

/// Ajoute `Authorization: Bearer <jeton>` (valeur marquée sensible : jamais affichée).
pub fn with_token(req: RequestBuilder, token: Option<&str>) -> RequestBuilder {
  match token.and_then(|t| HeaderValue::from_str(&format!("Bearer {t}")).ok()) {
    Some(mut v) => {
      v.set_sensitive(true);
      req.header(AUTHORIZATION, v)
    }
    None => req,
  }
}

/// Erreur réseau lisible (sans l'URL, qui peut contenir une signature de CDN).
pub fn net_error(e: reqwest::Error) -> String {
  if e.is_timeout() {
    "Hugging Face ne répond pas (délai dépassé) : vérifiez la connexion Internet.".into()
  } else if e.is_connect() {
    "Connexion à Hugging Face impossible : vérifiez la connexion Internet.".into()
  } else if e.is_redirect() {
    "Redirection refusée par Lucania (hôte non autorisé).".into()
  } else {
    format!("Erreur réseau : {}", e.without_url())
  }
}

/// Erreur HTTP lisible ; `not_found` sert pour 404.
pub fn status_error(status: StatusCode, not_found: &str) -> String {
  match status.as_u16() {
    401 | 403 => ACCESS_DENIED.into(),
    404 => not_found.into(),
    429 => "Trop de requêtes vers Hugging Face : réessayez dans quelques minutes.".into(),
    500..=599 => format!("Hugging Face est indisponible (HTTP {}), réessayez plus tard.", status.as_u16()),
    code => format!("Réponse inattendue de Hugging Face (HTTP {code})."),
  }
}

// ---------------------------------------------------------------------------------------------
// Recherche
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawModel {
  id: String,
  author: Option<String>,
  downloads: Option<u64>,
  likes: Option<u64>,
  last_modified: Option<String>,
  /// false, "auto" ou "manual"
  gated: Option<serde_json::Value>,
}

fn is_gated(v: &Option<serde_json::Value>) -> bool {
  match v {
    Some(serde_json::Value::Bool(b)) => *b,
    Some(serde_json::Value::String(s)) => !s.is_empty() && s != "false",
    _ => false,
  }
}

/// Dépôts GGUF les plus téléchargés correspondant à `query` (tous si vide).
pub async fn search(client: &Client, token: Option<&str>, query: &str, limit: u32) -> Result<Vec<SearchResult>, String> {
  let mut url = hf_url(&["api", "models"])?;
  {
    let mut q = url.query_pairs_mut();
    if !query.is_empty() {
      q.append_pair("search", query);
    }
    q.append_pair("filter", "gguf")
      .append_pair("sort", "downloads")
      .append_pair("direction", "-1")
      .append_pair("limit", &limit.to_string());
    // Sans `expand`, l'API ne renvoie ni l'auteur, ni la date, ni l'accès restreint.
    for field in ["author", "downloads", "likes", "lastModified", "gated"] {
      q.append_pair("expand[]", field);
    }
  }
  let resp = with_token(client.get(url), token).timeout(API_TIMEOUT).send().await.map_err(net_error)?;
  if !resp.status().is_success() {
    return Err(status_error(resp.status(), "Recherche indisponible sur Hugging Face."));
  }
  let raw: Vec<RawModel> = resp.json().await.map_err(|_| "Réponse de recherche illisible.".to_string())?;
  Ok(raw
    .into_iter()
    .map(|m| SearchResult {
      author: m.author.unwrap_or_else(|| m.id.split('/').next().unwrap_or_default().to_string()),
      downloads: m.downloads.unwrap_or(0),
      likes: m.likes.unwrap_or(0),
      last_modified: m.last_modified,
      gated: is_gated(&m.gated),
      id: m.id,
    })
    .collect())
}

// ---------------------------------------------------------------------------------------------
// Fichiers d'un dépôt
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct RawLfs {
  size: u64,
}

#[derive(Deserialize)]
struct RawEntry {
  #[serde(rename = "type")]
  kind: String,
  path: String,
  size: Option<u64>,
  lfs: Option<RawLfs>,
}

/// URL de la page suivante dans un en-tête `Link: <url>; rel="next"`, si elle reste sur
/// huggingface.co.
pub fn next_link(header: &str) -> Option<Url> {
  header.split(',').find_map(|part| {
    let (target, params) = part.trim().split_once(';')?;
    let is_next = params.split(';').any(|p| matches!(p.trim(), "rel=\"next\"" | "rel=next"));
    let url = Url::parse(target.trim().strip_prefix('<')?.strip_suffix('>')?).ok()?;
    (is_next && url.scheme() == "https" && url.host_str() == Some("huggingface.co")).then_some(url)
  })
}

/// Tous les fichiers du dépôt (branche main, récursif) : (chemin, taille). Taille = `lfs.size`
/// si présent, sinon `size`. Suit la pagination.
pub async fn list_tree(client: &Client, token: Option<&str>, repo: &str) -> Result<Vec<(String, u64)>, String> {
  let mut segments = vec!["api", "models"];
  segments.extend(repo.split('/'));
  segments.extend(["tree", "main"]);
  let mut url = hf_url(&segments)?;
  url.query_pairs_mut().append_pair("recursive", "true");

  let mut out = Vec::new();
  for _ in 0..MAX_PAGES {
    let resp = with_token(client.get(url), token).timeout(API_TIMEOUT).send().await.map_err(net_error)?;
    let status = resp.status();
    if status == StatusCode::UNAUTHORIZED && token.is_none() {
      // Hugging Face répond 401 pour un dépôt absent comme pour un dépôt privé.
      return Err(REPO_NOT_FOUND.into());
    }
    if !status.is_success() {
      return Err(status_error(status, REPO_NOT_FOUND));
    }
    let next = resp.headers().get(LINK).and_then(|v| v.to_str().ok()).and_then(next_link);
    let page: Vec<RawEntry> = resp.json().await.map_err(|_| "Liste des fichiers illisible.".to_string())?;
    out.extend(
      page
        .into_iter()
        .filter(|e| e.kind == "file")
        .map(|e| (e.path, e.lfs.map(|l| l.size).or(e.size).unwrap_or(0))),
    );
    match next {
      Some(n) => url = n,
      None => return Ok(out),
    }
  }
  Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Infos de fichiers précis et lecture partielle
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct RawLfsOid {
  oid: Option<String>,
  size: u64,
}

#[derive(Deserialize)]
struct RawPathInfo {
  #[serde(rename = "type")]
  kind: String,
  path: String,
  oid: Option<String>,
  size: Option<u64>,
  lfs: Option<RawLfsOid>,
}

/// Taille et empreinte (oid LFS, sinon oid git) d'un fichier du dépôt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathInfo {
  pub size: u64,
  pub oid: String,
}

/// Infos de quelques fichiers (branche main) : `POST /api/models/<repo>/paths-info/main`. Les
/// chemins absents du dépôt sont absents du résultat.
pub async fn paths_info(
  client: &Client,
  token: Option<&str>,
  repo: &str,
  paths: &[String],
) -> Result<std::collections::HashMap<String, PathInfo>, String> {
  let mut segments = vec!["api", "models"];
  segments.extend(repo.split('/'));
  segments.extend(["paths-info", "main"]);
  let url = hf_url(&segments)?;
  let body = serde_json::json!({ "paths": paths, "expand": false });
  let resp = with_token(client.post(url), token).json(&body).timeout(API_TIMEOUT).send().await.map_err(net_error)?;
  let status = resp.status();
  if status == StatusCode::UNAUTHORIZED && token.is_none() {
    return Err(REPO_NOT_FOUND.into());
  }
  if !status.is_success() {
    return Err(status_error(status, REPO_NOT_FOUND));
  }
  let raw: Vec<RawPathInfo> = resp.json().await.map_err(|_| "Infos du fichier illisibles.".to_string())?;
  Ok(raw
    .into_iter()
    .filter(|e| e.kind == "file")
    .map(|e| {
      let (size, oid) = match e.lfs {
        Some(l) => (l.size, l.oid.or(e.oid).unwrap_or_default()),
        None => (e.size.unwrap_or(0), e.oid.unwrap_or_default()),
      };
      (e.path, PathInfo { size, oid })
    })
    .collect())
}

/// Lit les octets `[start, end)` d'un fichier (`Range`, redirections du client : mêmes hôtes
/// que les téléchargements). Si le serveur ignore la plage (200), le début est sauté. La lecture
/// s'arrête dès que la plage est reçue (la connexion est alors abandonnée).
pub async fn fetch_range(client: &Client, token: Option<&str>, url: &Url, start: u64, end: u64) -> Result<Vec<u8>, String> {
  use futures_util::StreamExt;
  if end <= start {
    return Ok(Vec::new());
  }
  let want = end - start;
  let resp = with_token(client.get(url.clone()), token)
    .header(reqwest::header::RANGE, format!("bytes={start}-{}", end - 1))
    .send()
    .await
    .map_err(net_error)?;
  let status = resp.status();
  let mut skip = match status.as_u16() {
    206 => {
      let begin = resp
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes "))
        .and_then(|v| v.split_once('-'))
        .and_then(|(b, _)| b.trim().parse::<u64>().ok());
      if begin != Some(start) {
        return Err("Réponse partielle inattendue de Hugging Face.".into());
      }
      0
    }
    200 => start,
    _ => return Err(status_error(status, FILE_NOT_FOUND)),
  };
  let mut out = Vec::with_capacity(want.min(64 << 20) as usize);
  let mut stream = resp.bytes_stream();
  while (out.len() as u64) < want {
    let Some(chunk) = stream.next().await else { break };
    let chunk = chunk.map_err(net_error)?;
    let mut bytes = &chunk[..];
    if skip > 0 {
      let n = skip.min(bytes.len() as u64);
      skip -= n;
      bytes = &bytes[n as usize..];
    }
    let room = (want - out.len() as u64).min(bytes.len() as u64) as usize;
    out.extend_from_slice(&bytes[..room]);
  }
  if (out.len() as u64) < want {
    return Err("Lecture de l'en-tête interrompue (connexion coupée).".into());
  }
  Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Jeton
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct WhoAmI {
  name: Option<String>,
}

/// Valide un jeton et renvoie le nom d'utilisateur associé.
pub async fn whoami(client: &Client, token: &str) -> Result<String, String> {
  let url = hf_url(&["api", "whoami-v2"])?;
  let resp = with_token(client.get(url), Some(token)).timeout(API_TIMEOUT).send().await.map_err(net_error)?;
  match resp.status() {
    StatusCode::UNAUTHORIZED => Err(TOKEN_REFUSED.into()),
    s if !s.is_success() => Err(status_error(s, "Vérification du jeton impossible.")),
    _ => {
      let who: WhoAmI = resp.json().await.map_err(|_| "Réponse de Hugging Face illisible.".to_string())?;
      who.name.filter(|n| !n.is_empty()).ok_or_else(|| "Réponse de Hugging Face illisible.".to_string())
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn urls() {
    let u = resolve_url("unsloth/Qwen3-4B-GGUF", "Q4 K/a#b.gguf").unwrap();
    assert_eq!(u.as_str(), "https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Q4%20K/a%23b.gguf");
    assert!(allowed_host(&Url::parse("https://cdn-lfs.hf.co/x").unwrap()));
    assert!(allowed_host(&Url::parse("https://us.aws.cdn.hf.co/x").unwrap()));
    assert!(!allowed_host(&Url::parse("https://evil-hf.co/x").unwrap()));
    assert!(!allowed_host(&Url::parse("http://huggingface.co/x").unwrap()));
  }

  #[test]
  fn pagination() {
    let h = "<https://huggingface.co/api/models/a/b/tree/main?recursive=true&cursor=abc>; rel=\"next\"";
    assert_eq!(next_link(h).unwrap().query(), Some("recursive=true&cursor=abc"));
    assert!(next_link("<https://evil.example/x>; rel=\"next\"").is_none());
    assert!(next_link("<https://huggingface.co/x>; rel=\"prev\"").is_none());
  }

  #[test]
  fn acces_restreint() {
    assert!(!is_gated(&Some(serde_json::json!(false))));
    assert!(is_gated(&Some(serde_json::json!("auto"))));
    assert!(is_gated(&Some(serde_json::json!("manual"))));
    assert!(!is_gated(&None));
  }

  /// Test réseau (ignoré par défaut) : cargo test --lib hf -- --ignored --nocapture
  #[test]
  #[ignore]
  fn recherche_et_fichiers_reels() {
    tauri::async_runtime::block_on(async {
      let client = build_client("test").unwrap();
      let found = search(&client, None, "Qwen3-4B", 5).await.expect("recherche");
      for m in &found {
        eprintln!("{} ({}) - {} téléchargements, {} likes, {:?}, gated={}", m.id, m.author, m.downloads, m.likes, m.last_modified, m.gated);
      }
      assert!(!found.is_empty());
      assert!(found.iter().all(|m| !m.author.is_empty()));
      let gated = search(&client, None, "meta-llama", 30).await.expect("recherche");
      eprintln!("dépôts à accès restreint : {}", gated.iter().filter(|m| m.gated).count());

      let tree = list_tree(&client, None, "unsloth/Qwen3-4B-GGUF").await.expect("arbre");
      let groups = super::super::names::group_files(&tree);
      for g in &groups {
        eprintln!("{} {:?} {} octets {:?}", g.name, g.files, g.size_bytes, super::super::names::quant(&g.name));
      }
      assert!(groups.iter().any(|g| g.files == ["Qwen3-4B-Q4_K_M.gguf"]));
      // Dépôt avec annexes (tête MTP, imatrix, mmproj) : aucune ne doit être proposée.
      let tree = list_tree(&client, None, "unsloth/Qwen3.8-27B-GGUF").await.expect("arbre");
      let groups = super::super::names::group_files(&tree);
      let annexes: Vec<_> = tree.iter().filter(|(p, _)| super::super::names::is_annex_file(p)).map(|(p, _)| p.as_str()).collect();
      eprintln!("annexes écartées : {annexes:?} ; plus petit modèle proposé : {:?}", groups.first().map(|g| &g.files));
      assert!(annexes.iter().any(|p| p.starts_with("MTP/")));
      assert!(groups.iter().flat_map(|g| &g.files).all(|f| !super::super::names::is_annex_file(f)));
      assert!(list_tree(&client, None, "unsloth/existe-pas-123456").await.is_err());
      assert_eq!(whoami(&client, "hf_invalide").await, Err(TOKEN_REFUSED.into()));
    });
  }
}

