// Moteur llama.cpp embarqué dans le processus Tauri : modèles, état et génération (commandes + événements Tauri).
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { t } from './i18n.js';

/**
 * @typedef {{ role: 'system'|'user'|'assistant', content: string }} ChatMessage
 * @typedef {{ content: string, thinking: string }} ChatResult
 * @typedef {{ id: string, name: string, sizeBytes: number }} EngineModel
 * @typedef {{ backend: 'cuda'|'cpu', modelsDir: string }} EngineInfo
 * @typedef {{ loadedModel: string|null, loading: boolean, generating: boolean }} EngineStatus
 * @typedef {{ name: string, sizeBytes: number, modified: string }} CrashLogFile
 * @typedef {{ dir: string, files: CrashLogFile[] }} CrashLogs
 * @typedef {{ name: string, vramTotalBytes: number, vramFreeBytes: number|null }} SystemGpu
 * @typedef {{ ramTotalBytes: number, ramAvailableBytes: number, gpus: SystemGpu[], source: 'llama'|'nvidia-smi'|'none' }} SystemHardware
 * @typedef {'f16'|'q8_0'|'q4_0'} CacheType
 * @typedef {{ nCtx?: number|null, nGpuLayers?: number|null, nThreads?: number|null, nBatch?: number|null, flashAttn?: boolean|null, cacheTypeK?: CacheType|null, cacheTypeV?: CacheType|null }} LoadOptions nCtx 0 = contexte d'entraînement du modèle ; nGpuLayers null = automatique
 * @typedef {{ temperature?: number|null, topP?: number|null, topK?: number|null, minP?: number|null, repeatPenalty?: number|null, maxTokens?: number|null, seed?: number|null, systemPrompt?: string|null, useProfile?: boolean }} GenParams seed null ou négatif = aléatoire ; ne jamais envoyer useProfile dans un profil
 * @typedef {{ load: LoadOptions, gen: GenParams }} ModelProfile champ absent ou null = valeur par défaut
 * @typedef {{ blockCount: number|null, headCount: number|null, headCountKv: number|null, keyLength: number|null, valueLength: number|null, embeddingLength: number|null, contextLength: number|null }} ArchMeta
 * @typedef {{ load: { nCtx: number, nGpuLayers: number|null, nThreads: number, nBatch: number, flashAttn: boolean, cacheTypeK: CacheType, cacheTypeV: CacheType }, gen: { temperature: number, topP: number, topK: number, minP: number, repeatPenalty: number, maxTokens: number, seed: number|null, systemPrompt: string } }} ProfileDefaults
 * @typedef {{ modelId: string, profile: ModelProfile, defaults: ProfileDefaults, meta: ArchMeta|null, sizeBytes: number, loaded: boolean, loadedGpuLayers: number|null, gpuBuild: boolean }} ProfileInfo
 * @typedef {{ loadChanged: boolean, loaded: boolean }} SaveResult
 * @typedef {{ modelId?: string, sizeBytes?: number, meta?: ArchMeta, options?: LoadOptions, vramBytes?: number, ramBytes?: number }} EstimateInput
 * @typedef {{ known: boolean, blockCount: number|null, gpuLayers: number, autoGpuLayers: number, nCtx: number, maxContext: number|null, weightsGpuBytes: number, weightsCpuBytes: number, kvGpuBytes: number, kvCpuBytes: number, computeBytes: number, totalGpuBytes: number, vramBytes: number, ramBytes: number, fits: boolean, fit: 'gpu'|'mixed'|'cpu'|'too-big' }} VramEstimate
 */

/** Vrai si la page tourne dans la fenêtre Tauri (et non dans un simple navigateur). */
export function engineAvailable() {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

/** Le moteur ne fait qu'une génération à la fois : chat et extraction de mémoire passent l'un après l'autre. */
let queue = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/** Lève une erreur claire si le moteur n'est pas joignable. */
function requireEngine() {
  if (!engineAvailable()) throw new Error(t('chat.engine.unavailable'));
}

/**
 * Sépare le raisonnement `<think>…</think>` de la réponse.
 * @param {string} raw
 * @returns {{ content: string, thinking: string }}
 */
function splitThinking(raw) {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('<think>')) return { content: raw, thinking: '' };
  const rest = trimmed.slice('<think>'.length);
  const end = rest.indexOf('</think>');
  if (end === -1) return { content: '', thinking: rest };
  return {
    thinking: rest.slice(0, end),
    content: rest.slice(end + '</think>'.length).trimStart(),
  };
}

/** @returns {Promise<EngineInfo>} */
export async function getEngineInfo() {
  requireEngine();
  return invoke('engine_info');
}

/** @returns {Promise<EngineModel[]>} */
export async function listModels() {
  requireEngine();
  const list = await invoke('engine_list_models');
  return Array.isArray(list) ? list : [];
}

/** @returns {Promise<EngineStatus>} */
export async function getEngineStatus() {
  requireEngine();
  return invoke('engine_status');
}

/**
 * Écoute les changements d'état du moteur.
 * @param {(status: EngineStatus) => void} cb
 * @returns {Promise<() => void>} fonction de désabonnement
 */
export async function onEngineStatus(cb) {
  requireEngine();
  return listen('engine://status', (event) => cb(/** @type {EngineStatus} */ (event.payload)));
}

/**
 * Charge un modèle en mémoire (remplace le modèle chargé s'il y en a un).
 * @param {string} id identifiant moteur du modèle
 * @returns {Promise<void>}
 */
export async function loadModel(id) {
  requireEngine();
  await invoke('engine_load', { modelId: id });
}

/** Décharge le modèle courant. @returns {Promise<void>} */
export async function unloadModel() {
  requireEngine();
  await invoke('engine_unload');
}

/**
 * Réglages enregistrés d'un modèle, valeurs par défaut et métadonnées d'architecture.
 * @param {string} id identifiant moteur du modèle
 * @returns {Promise<ProfileInfo>}
 */
export async function getModelProfile(id) {
  requireEngine();
  return invoke('engine_get_profile', { modelId: id });
}

/**
 * Enregistre les réglages d'un modèle.
 * @param {string} id identifiant moteur du modèle
 * @param {ModelProfile} profile
 * @returns {Promise<SaveResult>}
 */
export async function setModelProfile(id, profile) {
  requireEngine();
  return invoke('engine_set_profile', { modelId: id, profile });
}

/**
 * Efface les réglages d'un modèle (retour aux valeurs par défaut).
 * @param {string} id identifiant moteur du modèle
 * @returns {Promise<SaveResult>}
 */
export async function resetModelProfile(id) {
  requireEngine();
  return invoke('engine_reset_profile', { modelId: id });
}

/**
 * Estime la mémoire (GPU et RAM) qu'un modèle utiliserait avec ces options de chargement.
 * @param {EstimateInput} input
 * @returns {Promise<VramEstimate>}
 */
export async function estimateVram(input) {
  requireEngine();
  return invoke('engine_estimate', { input });
}

/** Arrête la génération en cours, quelle qu'elle soit. @returns {Promise<void>} */
export async function stopGeneration() {
  requireEngine();
  await invoke('engine_stop', { requestId: null });
}

/**
 * Supprime le fichier d'un modèle installé.
 * @param {string} id identifiant moteur du modèle
 * @returns {Promise<void>}
 */
export async function deleteModel(id) {
  requireEngine();
  await invoke('engine_delete_model', { modelId: id });
}

/**
 * Charge le modèle puis le mémorise comme modèle par défaut du chat (clé `lastModel`).
 * @param {string} id identifiant moteur du modèle
 * @returns {Promise<void>}
 */
export async function useModel(id) {
  await loadModel(id);
  try {
    localStorage.setItem('lastModel', 'local::' + id);
  } catch {
    /* stockage indisponible : le modèle reste chargé */
  }
}

/**
 * Mémoire vive et cartes graphiques de cet ordinateur.
 * @returns {Promise<SystemHardware>}
 */
export async function getSystemHardware() {
  requireEngine();
  return invoke('system_hardware');
}

/**
 * Dossier des journaux de plantage et fichiers présents (du plus récent au plus ancien).
 * @returns {Promise<CrashLogs>}
 */
export async function getCrashLogs() {
  requireEngine();
  return invoke('app_crash_logs');
}

/** Ouvre le dossier des journaux de plantage dans l'explorateur. @returns {Promise<void>} */
export async function openCrashLogs() {
  requireEngine();
  await invoke('app_open_crash_logs');
}

/**
 * Génère une réponse en flux. Sur `signal.abort()`, la génération est arrêtée côté moteur
 * puis la promesse est rejetée avec une DOMException `AbortError` (le texte partiel
 * déjà transmis via `onUpdate` reste utilisable par l'appelant).
 * @param {{ model: string, messages: ChatMessage[], signal?: AbortSignal, onUpdate?: (r: ChatResult) => void }} opts
 * @returns {Promise<ChatResult>}
 */
export async function streamChat({ model, messages, signal, onUpdate }) {
  requireEngine();
  if (signal && signal.aborted) throw new DOMException('Génération interrompue', 'AbortError');
  const requestId = crypto.randomUUID();
  let raw = '';
  /** @type {ChatResult} */
  let result = { content: '', thinking: '' };
  const publish = () => {
    result = splitThinking(raw);
    if (onUpdate) onUpdate(result);
  };

  // Abonnement AVANT le lancement, pour ne perdre aucun morceau.
  const unlisten = await listen('engine://token', (event) => {
    const p = /** @type {{ requestId: string, text: string }} */ (event.payload);
    if (!p || p.requestId !== requestId || typeof p.text !== 'string') return;
    raw += p.text;
    publish();
  });
  const onAbort = () => {
    invoke('engine_stop', { requestId }).catch(() => {});
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await enqueue(() =>
      signal && signal.aborted ? Promise.resolve(null) : invoke('engine_generate', { requestId, modelId: model, messages }),
    );
    if (res && typeof res.content === 'string' && res.content !== raw) {
      raw = res.content; // le texte final fait foi si un événement s'est perdu
      publish();
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    unlisten();
  }
  if (signal && signal.aborted) throw new DOMException('Génération interrompue', 'AbortError');
  return result;
}

/**
 * Génère un texte complet, sans flux (tâches internes comme l'extraction de mémoire).
 * @param {{ model: string, messages: ChatMessage[], maxTokens?: number }} opts
 * @returns {Promise<string>}
 */
export async function generateText({ model, messages, maxTokens }) {
  requireEngine();
  // Tâche interne : on ignore les réglages de génération et le prompt système du modèle.
  const params = { useProfile: false, ...(typeof maxTokens === 'number' ? { maxTokens } : {}) };
  const res = await enqueue(() =>
    invoke('engine_generate', { requestId: crypto.randomUUID(), modelId: model, messages, params }),
  );
  const text = res && typeof res.content === 'string' ? res.content : '';
  return splitThinking(text).content;
}
