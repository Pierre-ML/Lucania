// Hugging Face : recherche, téléchargement de modèles GGUF et jeton (commandes `hf_*` + événements Tauri).
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { engineAvailable } from './engine.js';
import { t } from './i18n.js';

/**
 * @typedef {{ id: string, author: string, downloads: number, likes: number, lastModified: string|null, gated: boolean }} HfRepo
 * @typedef {{ name: string, files: string[], sizeBytes: number, quant: string|null, installed: boolean, annexHint: boolean }} HfFile
 * @typedef {{ standalone: boolean, reason: string|null, architecture: string|null, blockCount: number|null, contextLength: number|null, paramCount: number|null }} HfFileCheck
 * @typedef {'downloading'|'paused'|'completed'|'error'} DownloadState
 * @typedef {{ id: string, repo: string, files: string[], modelId: string, state: DownloadState, downloadedBytes: number, totalBytes: number|null, speedBps: number, error: string|null }} DownloadInfo
 * @typedef {{ hasToken: boolean, user: string|null }} TokenStatus
 */

/** Lève une erreur claire hors de la fenêtre Tauri. */
function requireTauri() {
  if (!engineAvailable()) throw new Error(t('chat.engine.unavailable'));
}

/**
 * Les commandes Tauri rejettent avec une simple chaîne : on la ramène à un message lisible.
 * @param {unknown} e
 * @returns {string}
 */
export function errorMessage(e) {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e && typeof e.message === 'string') return e.message;
  return String(e);
}

/**
 * @param {string} query vide = les plus téléchargés
 * @param {number} [limit]
 * @returns {Promise<HfRepo[]>}
 */
export async function searchRepos(query, limit) {
  requireTauri();
  const args = typeof limit === 'number' ? { query, limit } : { query };
  const list = await invoke('hf_search', args);
  return Array.isArray(list) ? list : [];
}

/**
 * @param {string} repo
 * @returns {Promise<HfFile[]>}
 */
export async function listRepoFiles(repo) {
  requireTauri();
  const list = await invoke('hf_list_files', { repo });
  return Array.isArray(list) ? list : [];
}

/**
 * Lit l'en-tête d'un fichier GGUF du dépôt (sans le télécharger) pour savoir s'il s'agit d'un modèle complet.
 * @param {string} repo
 * @param {string[]} files fichier ou parties d'un modèle découpé
 * @returns {Promise<HfFileCheck>}
 */
export async function checkFile(repo, files) {
  requireTauri();
  return invoke('hf_check_file', { repo, files });
}

/**
 * Avatars des organisations / auteurs (30 noms au plus par appel).
 * @param {string[]} names
 * @returns {Promise<Record<string, string|null>>} URL de données (data:) ou null
 */
export async function getAvatars(names) {
  requireTauri();
  const map = await invoke('hf_avatars', { names });
  return map && typeof map === 'object' ? map : {};
}

/**
 * Lance un téléchargement (un fichier, ou toutes les parties d'un modèle découpé).
 * @param {string} repo
 * @param {string[]} files
 * @returns {Promise<string>} identifiant du téléchargement
 */
export async function startDownload(repo, files) {
  requireTauri();
  return invoke('hf_download', { repo, files });
}

/** @param {string} id @returns {Promise<void>} */
export async function pauseDownload(id) {
  requireTauri();
  await invoke('hf_pause', { id });
}

/** @param {string} id @returns {Promise<void>} */
export async function resumeDownload(id) {
  requireTauri();
  await invoke('hf_resume', { id });
}

/** @param {string} id @returns {Promise<void>} */
export async function cancelDownload(id) {
  requireTauri();
  await invoke('hf_cancel', { id });
}

/** @returns {Promise<DownloadInfo[]>} */
export async function listDownloads() {
  requireTauri();
  const list = await invoke('hf_list_downloads');
  return Array.isArray(list) ? list : [];
}

/**
 * Écoute les mises à jour de téléchargement.
 * @param {(info: DownloadInfo) => void} cb
 * @returns {Promise<() => void>} fonction de désabonnement
 */
export async function onDownload(cb) {
  requireTauri();
  return listen('hf://download', (event) => cb(/** @type {DownloadInfo} */ (event.payload)));
}

/**
 * Écoute les téléchargements annulés (retirés de la liste).
 * @param {(payload: { id: string }) => void} cb
 * @returns {Promise<() => void>} fonction de désabonnement
 */
export async function onDownloadRemoved(cb) {
  requireTauri();
  return listen('hf://download-removed', (event) => cb(/** @type {{ id: string }} */ (event.payload)));
}

/** @returns {Promise<TokenStatus>} */
export async function getTokenStatus() {
  requireTauri();
  return invoke('hf_token_status');
}

/**
 * Enregistre (ou supprime avec null / '') le jeton Hugging Face.
 * @param {string|null} token
 * @returns {Promise<TokenStatus>}
 */
export async function setToken(token) {
  requireTauri();
  return invoke('hf_set_token', { token: token || null });
}
