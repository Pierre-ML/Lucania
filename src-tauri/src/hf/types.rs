//! Types échangés avec les pages (JSON en camelCase).

use serde::{Deserialize, Serialize};

use crate::engine::gguf::ArchMeta;

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
  /// Indice tiré du nom (« draft », « mtp », « nextn », « assistant-head ») : le fichier est
  /// peut-être une annexe. Simple indice, le fichier reste proposé.
  pub annex_hint: bool,
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

/// Résultat de la vérification à distance d'un fichier GGUF (`hf_check_file`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCheck {
  /// Modèle de chat utilisable seul.
  pub standalone: bool,
  /// Raison du refus (même texte que le refus au chargement), null si autonome.
  pub reason: Option<String>,
  pub architecture: Option<String>,
  pub block_count: Option<u64>,
  pub context_length: Option<u64>,
  pub param_count: Option<u64>,
  /// Dimensions pour l'estimation mémoire ; null pour un refus ou un ancien résultat en cache.
  #[serde(default)]
  pub meta: Option<ArchMeta>,
}
