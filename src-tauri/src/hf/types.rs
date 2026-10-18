//! Types échangés avec les pages (JSON en camelCase).

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
  pub id: String,
  pub author: String,
  pub downloads: u64,
  pub likes: u64,
  pub last_modified: Option<String>,
  /// Accès restreint (licence à accepter, jeton nécessaire).
  pub gated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoModel {
  /// Nom du fichier sans dossier, ".gguf" ni suffixe "-00001-of-0000N".
  pub name: String,
  /// Chemins dans le dépôt (plusieurs pour un modèle découpé, triés).
  pub files: Vec<String>,
  pub size_bytes: u64,
  pub quant: Option<String>,
  pub installed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadState {
  Downloading,
  Paused,
  Completed,
  Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInfo {
  /// `<repo>/<files[0]>`
  pub id: String,
  pub repo: String,
  pub files: Vec<String>,
  /// Identifiant moteur du modèle (premier fichier) ; égal à `id`.
  pub model_id: String,
  pub state: DownloadState,
  pub downloaded_bytes: u64,
  /// Inconnu (null) pour un téléchargement retrouvé au démarrage, jusqu'à sa reprise.
  pub total_bytes: Option<u64>,
  pub speed_bps: u64,
  pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenStatus {
  pub has_token: bool,
  pub user: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadRemoved {
  pub id: String,
}
