//! Tâche de téléchargement d'un modèle (un ou plusieurs fichiers, l'un après l'autre).
//!
//! Chaque fichier est écrit dans `<dest>.part`, puis renommé en `<dest>` quand la taille annoncée
//! par Hugging Face est atteinte (pas de contrôle sha256 : il faudrait relire tout le fichier à
//! chaque reprise). Reprise par `Range: bytes=<taille du .part>-` : 206 = suite du fichier,
//! 200 = le serveur repart de zéro (le .part est tronqué). Pour un modèle découpé, la première
//! partie est téléchargée en dernier : le moteur ne voit le modèle qu'une fois complet.

use std::collections::HashMap;
use std::future::Future;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::header::{CONTENT_RANGE, HeaderMap, RANGE};
use reqwest::{Client, Response, Url};
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::Notify;

use super::types::DownloadState;
use super::{Hf, api, log, names};

/// Intervalle minimal entre deux événements de progression d'un même téléchargement.
const EMIT_EVERY: Duration = Duration::from_millis(250);

const SIZE_MISMATCH: &str = "Taille du fichier différente de celle annoncée par Hugging Face.";
const INCOMPLETE: &str = "Téléchargement incomplet (connexion interrompue) : il peut être repris.";

enum Outcome {
  Done,
  /// Pause ou annulation : l'état a déjà été mis à jour par la commande.
  Stopped,
}

struct Ctx {
  hf: Hf,
  id: String,
  run: u64,
  wake: Arc<Notify>,
}

impl Ctx {
  fn current(&self) -> bool {
    self.hf.is_current(&self.id, self.run)
  }

  /// Se termine dès que cette tâche n'est plus la tâche courante (pause, annulation).
  async fn stopped(&self) {
    while self.current() {
      self.wake.notified().await;
    }
  }

  /// Exécute `fut` sauf si la tâche est arrêtée entre-temps (None).
  async fn or_stop<T>(&self, fut: impl Future<Output = T>) -> Option<T> {
    tokio::select! {
      biased;
      _ = self.stopped() => None,
      v = fut => Some(v),
    }
  }
}

/// Débit lissé et limitation de la fréquence des événements.
struct Meter {
  last: Instant,
  last_bytes: u64,
  speed: f64,
}

impl Meter {
  fn tick(&mut self, ctx: &Ctx, downloaded: u64) {
    let elapsed = self.last.elapsed();
    if elapsed < EMIT_EVERY {
      return;
    }
    let instant = downloaded.saturating_sub(self.last_bytes) as f64 / elapsed.as_secs_f64();
    self.speed = if self.speed <= 0.0 { instant } else { 0.6 * self.speed + 0.4 * instant };
    self.last = Instant::now();
    self.last_bytes = downloaded;
    let speed = self.speed as u64;
    ctx.hf.update(&ctx.id, ctx.run, |d| {
      d.downloaded_bytes = downloaded;
      d.speed_bps = speed;
    });
  }

  fn rebase(&mut self, downloaded: u64) {
    self.last = Instant::now();
    self.last_bytes = downloaded;
  }
}

/// Erreur d'écriture lisible (sans chemin).
fn io_error(e: std::io::Error) -> String {
  let disk_full = e.kind() == ErrorKind::StorageFull
    || matches!(e.raw_os_error(), Some(code) if if cfg!(windows) { code == 39 || code == 112 } else { code == 28 });
  if disk_full {
    "Espace disque insuffisant : libérez de la place puis reprenez le téléchargement.".into()
  } else if e.kind() == ErrorKind::PermissionDenied {
    "Écriture refusée dans le dossier des modèles (droits insuffisants ou fichier utilisé par un autre programme).".into()
  } else {
    format!("Écriture impossible dans le dossier des modèles : {e}")
  }
}

async fn file_len(path: &Path) -> Option<u64> {
  tokio::fs::metadata(path).await.ok().filter(|m| m.is_file()).map(|m| m.len())
}

/// `Content-Range: bytes <début>-<fin>/<total|*>` -> (début, total).
fn content_range(headers: &HeaderMap) -> Option<(u64, Option<u64>)> {
  let v = headers.get(CONTENT_RANGE)?.to_str().ok()?;
  let (range, total) = v.strip_prefix("bytes ")?.split_once('/')?;
  let start = range.split_once('-')?.0.trim().parse().ok()?;
  Some((start, total.trim().parse().ok()))
}

/// Point d'entrée de la tâche (lancée par `Hf::start`).
pub(super) async fn run(hf: Hf, id: String, repo: String, files: Vec<String>, run: u64, wake: Arc<Notify>) {
  let file_lock = hf.file_lock(&id);
  let _guard = file_lock.lock().await;
  let ctx = Ctx { hf, id, run, wake };
  if !ctx.current() {
    return;
  }
  match transfer(&ctx, &repo, &files).await {
    Ok(Outcome::Done) => ctx.hf.update(&ctx.id, ctx.run, |d| {
      d.state = DownloadState::Completed;
      d.speed_bps = 0;
      d.error = None;
      if let Some(total) = d.total_bytes {
        d.downloaded_bytes = total;
      }
    }),
    Ok(Outcome::Stopped) => {}
    Err(msg) => {
      if ctx.current() {
        log(&format!("téléchargement {} : {msg}", ctx.id));
      }
      ctx.hf.update(&ctx.id, ctx.run, |d| {
        d.state = DownloadState::Error;
        d.speed_bps = 0;
        d.error = Some(msg);
      });
    }
  }
}

async fn transfer(ctx: &Ctx, repo: &str, files: &[String]) -> Result<Outcome, String> {
  let client = ctx.hf.client()?;
  let token = ctx.hf.token();
  let token = token.as_deref();

  // Tailles attendues, lues dans la liste des fichiers du dépôt.
  let Some(tree) = ctx.or_stop(api::list_tree(&client, token, repo)).await else {
    return Ok(Outcome::Stopped);
  };
  let sizes: HashMap<String, u64> = tree?.into_iter().collect();
  let mut plan = Vec::with_capacity(files.len());
  for f in files {
    let expected = *sizes.get(f).ok_or(api::FILE_NOT_FOUND)?;
    let dest = names::dest_path(ctx.hf.models_dir(), repo, f)?;
    let url = api::resolve_url(repo, f)?;
    plan.push((dest, url, expected));
  }
  let total: u64 = plan.iter().map(|(_, _, s)| s).sum();

  // Octets déjà présents (fichiers terminés ou .part).
  let mut have = Vec::with_capacity(plan.len());
  for (dest, _, expected) in &plan {
    let n = match file_len(dest).await {
      Some(n) if n == *expected => n,
      _ => file_len(&names::part_path(dest)).await.unwrap_or(0).min(*expected),
    };
    have.push(n);
  }
  let present: u64 = have.iter().sum();
  ctx.hf.update(&ctx.id, ctx.run, |d| {
    d.total_bytes = Some(total);
    d.downloaded_bytes = present;
  });

  let mut meter = Meter { last: Instant::now(), last_bytes: present, speed: 0.0 };
  // Parties secondaires d'abord, première partie en dernier.
  for i in (1..plan.len()).chain(std::iter::once(0)) {
    let (dest, url, expected) = &plan[i];
    let others: u64 = have.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, n)| n).sum();
    match fetch_file(ctx, &client, token, url, dest, *expected, others, &mut meter).await? {
      Outcome::Stopped => return Ok(Outcome::Stopped),
      Outcome::Done => have[i] = *expected,
    }
  }
  Ok(Outcome::Done)
}

/// Télécharge un fichier (avec reprise) jusqu'à son renommage final.
#[allow(clippy::too_many_arguments)]
async fn fetch_file(
  ctx: &Ctx,
  client: &Client,
  token: Option<&str>,
  url: &Url,
  dest: &Path,
  expected: u64,
  others: u64,
  meter: &mut Meter,
) -> Result<Outcome, String> {
  if file_len(dest).await == Some(expected) {
    return Ok(Outcome::Done);
  }
  if let Some(parent) = dest.parent() {
    tokio::fs::create_dir_all(parent).await.map_err(io_error)?;
  }
  let part = names::part_path(dest);
  // Un .part plus grand que prévu est recommencé de zéro.
  let mut offset = file_len(&part).await.unwrap_or(0);
  if offset > expected {
    offset = 0;
  }
  for _ in 0..2 {
    if offset == expected {
      return finalize(&part, dest).await.map(|_| Outcome::Done);
    }
    let mut req = api::with_token(client.get(url.clone()), token);
    if offset > 0 {
      req = req.header(RANGE, format!("bytes={offset}-"));
    }
    let Some(resp) = ctx.or_stop(req.send()).await else {
      return Ok(Outcome::Stopped);
    };
    let resp = resp.map_err(api::net_error)?;
    let status = resp.status();
    let append = match status.as_u16() {
      206 => match content_range(resp.headers()) {
        Some((_, Some(t))) if t != expected => return Err(SIZE_MISMATCH.into()),
        Some((start, _)) if start == offset => true,
        // Reprise mal comprise par le serveur : on recommence de zéro.
        _ => {
          offset = 0;
          continue;
        }
      },
      200 => {
        if resp.content_length().is_some_and(|n| n != expected) {
          return Err(SIZE_MISMATCH.into());
        }
        false
      }
      416 => {
        offset = 0;
        continue;
      }
      _ => return Err(api::status_error(status, api::FILE_NOT_FOUND)),
    };
    if !append {
      offset = 0;
    }
    return stream_to(ctx, resp, &part, dest, offset, append, expected, others, meter).await;
  }
  Err("Reprise du téléchargement refusée par le serveur.".into())
}

#[allow(clippy::too_many_arguments)]
async fn stream_to(
  ctx: &Ctx,
  resp: Response,
  part: &Path,
  dest: &Path,
  offset: u64,
  append: bool,
  expected: u64,
  others: u64,
  meter: &mut Meter,
) -> Result<Outcome, String> {
  let file = tokio::fs::OpenOptions::new()
    .create(true)
    .write(true)
    .append(append)
    .truncate(!append)
    .open(part)
    .await
    .map_err(io_error)?;
  let mut out = BufWriter::with_capacity(1 << 20, file);
  let mut written = offset;
  meter.rebase(others + written);
  let mut stream = resp.bytes_stream();
  loop {
    let next = tokio::select! {
      biased;
      _ = ctx.stopped() => None,
      chunk = stream.next() => Some(chunk),
    };
    let Some(chunk) = next else {
      // Pause ou annulation : on garde ce qui est reçu.
      let _ = out.flush().await;
      return Ok(Outcome::Stopped);
    };
    match chunk {
      None => break,
      Some(Err(e)) => {
        let _ = out.flush().await;
        return Err(format!("{} Le téléchargement peut être repris.", api::net_error(e)));
      }
      Some(Ok(bytes)) => {
        written += bytes.len() as u64;
        if written > expected {
          let _ = out.flush().await;
          return Err(SIZE_MISMATCH.into());
        }
        out.write_all(&bytes).await.map_err(io_error)?;
        meter.tick(ctx, others + written);
      }
    }
  }
  out.flush().await.map_err(io_error)?;
  let file = out.into_inner();
  file.sync_all().await.map_err(io_error)?;
  drop(file);
  if written != expected {
    return Err(INCOMPLETE.into());
  }
  finalize(part, dest).await?;
  Ok(Outcome::Done)
}

/// Renomme `<dest>.part` en `<dest>` (remplace un éventuel fichier incomplet du même nom).
async fn finalize(part: &Path, dest: &Path) -> Result<(), String> {
  if file_len(part).await.is_none() {
    // Fichier vide annoncé de taille 0 : rien n'a été écrit.
    tokio::fs::File::create(part).await.map_err(io_error)?;
  }
  tokio::fs::rename(part, dest).await.map_err(io_error)
}

#[cfg(test)]
mod tests {
  use super::*;
  use reqwest::header::HeaderValue;

  #[test]
  fn plage_de_contenu() {
    let mut h = HeaderMap::new();
    assert_eq!(content_range(&h), None);
    h.insert(CONTENT_RANGE, HeaderValue::from_static("bytes 100-199/2497281312"));
    assert_eq!(content_range(&h), Some((100, Some(2_497_281_312))));
    h.insert(CONTENT_RANGE, HeaderValue::from_static("bytes 5-9/*"));
    assert_eq!(content_range(&h), Some((5, None)));
  }

  #[test]
  fn disque_plein() {
    let e = std::io::Error::from(ErrorKind::StorageFull);
    assert!(io_error(e).starts_with("Espace disque insuffisant"));
    #[cfg(windows)]
    assert!(io_error(std::io::Error::from_raw_os_error(112)).starts_with("Espace disque insuffisant"));
  }
}
