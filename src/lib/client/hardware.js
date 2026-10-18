// Matériel de l'ordinateur (RAM, carte graphique) : détection automatique ou profil saisi à la main,
// et estimation de ce qu'un modèle de telle taille peut faire sur ce matériel.
import { invoke } from '@tauri-apps/api/core';
import { engineAvailable, getSystemHardware } from './engine.js';
import { getLang, t } from './i18n.js';
import { getRemoteConfig, onRemoteState } from './remote.js';

/**
 * @typedef {{ ramBytes: number, vramBytes: number, gpuName: string, source: 'auto'|'manual' }} HardwareProfileBase
 * @typedef {HardwareProfileBase & { known: boolean, remote: boolean }} HardwareProfile known : false si rien n'a pu être détecté ; remote : true si le profil est celui de la tour (mode distant)
 * @typedef {'gpu'|'mixed'|'cpu'|'too-big'} Fit
 * @typedef {{ blockCount: number|null, headCount: number|null, headCountKv: number|null, keyLength: number|null, valueLength: number|null, embeddingLength: number|null, contextLength: number|null }} ArchMeta
 */

const STORAGE_KEY = 'hardwareProfile';
const EVENT_NAME = 'lucania:hardware';
const GIB = 1024 ** 3;

/** Choix de RAM proposés pour la saisie manuelle (en Go). */
export const RAM_OPTIONS_GB = [8, 16, 24, 32, 48, 64, 96, 128, 192, 256];

/** Cartes graphiques courantes pour la saisie manuelle (nom + VRAM en Go). Le premier choix, sans carte, est ajouté par l'interface. */
export const GPU_PRESETS = [
  { name: 'RTX 3060', vramGb: 12 },
  { name: 'RTX 3070', vramGb: 8 },
  { name: 'RTX 3080', vramGb: 10 },
  { name: 'RTX 3090', vramGb: 24 },
  { name: 'RTX 4060', vramGb: 8 },
  { name: 'RTX 4060 Ti', vramGb: 16 },
  { name: 'RTX 4070', vramGb: 12 },
  { name: 'RTX 4070 Ti Super', vramGb: 16 },
  { name: 'RTX 4080', vramGb: 16 },
  { name: 'RTX 4090', vramGb: 24 },
  { name: 'RTX 5060 Ti', vramGb: 16 },
  { name: 'RTX 5070', vramGb: 12 },
  { name: 'RTX 5070 Laptop', vramGb: 8 },
  { name: 'RTX 5080', vramGb: 16 },
  { name: 'RTX 5090', vramGb: 32 },
  { name: 'Radeon RX 7900 XTX', vramGb: 24 },
];

/** @type {Promise<HardwareProfile>|null} */
let autoPromise = null;

/** @param {unknown} v */
function nonNegative(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** Profil saisi à la main, ou null. @returns {HardwareProfile|null} */
function readManual() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return null;
    const ramBytes = nonNegative(o.ramBytes);
    const vramBytes = nonNegative(o.vramBytes);
    if (ramBytes <= 0 && vramBytes <= 0) return null;
    return { ramBytes, vramBytes, gpuName: typeof o.gpuName === 'string' ? o.gpuName : '', source: 'manual', known: true, remote: false };
  } catch {
    return null;
  }
}

/** Mode distant mémorisé (null = pas encore lu). @type {Promise<boolean>|null} */
let remoteModePromise = null;
/** Dernier mode connu, pour repérer un changement. @type {boolean|null} */
let lastRemote = null;
let remoteWatched = false;

/** Abonnement unique à l'état distant : changement de mode ou reconnexion = nouvelle détection et nouvelles estimations. */
async function watchRemote() {
  if (remoteWatched) return;
  remoteWatched = true;
  try {
    await onRemoteState((s) => {
      const remote = Boolean(s && s.mode === 'remote');
      const changed = lastRemote !== null && remote !== lastRemote;
      const reconnected = remote && Boolean(s.connected);
      remoteModePromise = Promise.resolve(remote);
      lastRemote = remote;
      if (changed || reconnected) {
        autoPromise = null;
        clearFitCache();
        notify();
      }
    });
  } catch {
    /* hors Tauri : pas de mode distant */
  }
}

/** Vrai si le moteur est relayé vers une tour (mode distant). Mémorisé, invalidé par les changements d'état distant. @returns {Promise<boolean>} */
export function isRemoteMode() {
  if (!remoteModePromise) {
    remoteModePromise = (async () => {
      let remote = false;
      try {
        remote = (await getRemoteConfig()).mode === 'remote';
      } catch {
        remote = false;
      }
      lastRemote = remote;
      return remote;
    })();
    watchRemote();
  }
  return remoteModePromise;
}

/** Détection automatique (une seule fois par session). @returns {Promise<HardwareProfile>} */
function detectAuto() {
  if (autoPromise) return autoPromise;
  autoPromise = (async () => {
    /** @type {HardwareProfile} */
    const none = { ramBytes: 0, vramBytes: 0, gpuName: '', source: 'auto', known: false, remote: false };
    if (!engineAvailable()) return none;
    const remote = await isRemoteMode();
    none.remote = remote;
    try {
      const hw = await getSystemHardware();
      const gpus = Array.isArray(hw.gpus) ? hw.gpus : [];
      let best = null;
      for (const g of gpus) {
        if (!best || nonNegative(g.vramTotalBytes) > nonNegative(best.vramTotalBytes)) best = g;
      }
      const ramBytes = nonNegative(hw.ramTotalBytes);
      return {
        ramBytes,
        vramBytes: best ? nonNegative(best.vramTotalBytes) : 0,
        gpuName: best && typeof best.name === 'string' ? best.name : '',
        source: 'auto',
        known: ramBytes > 0,
        remote,
      };
    } catch {
      autoPromise = null; // on réessaiera à la prochaine demande
      return none;
    }
  })();
  return autoPromise;
}

/** Profil à utiliser : celui saisi à la main s'il existe (sauf en mode distant : détection de la tour), sinon la détection. @returns {Promise<HardwareProfile>} */
export async function getHardwareProfile() {
  if (await isRemoteMode()) return detectAuto();
  return readManual() || (await detectAuto());
}

/** Profil détecté automatiquement (même si un profil manuel existe). @returns {Promise<HardwareProfile>} */
export function getDetectedHardware() {
  return detectAuto();
}

/** Profil saisi à la main, ou null. @returns {HardwareProfile|null} */
export function getManualHardware() {
  return readManual();
}

function notify() {
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

/**
 * Mémorise un profil saisi à la main.
 * @param {{ ramBytes: number, vramBytes: number, gpuName: string }} p
 */
export function setManualHardware({ ramBytes, vramBytes, gpuName }) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ramBytes: nonNegative(ramBytes), vramBytes: nonNegative(vramBytes), gpuName: String(gpuName || '') }),
    );
  } catch {
    /* stockage indisponible : le profil reste celui de la détection */
  }
  notify();
}

/** Revient à la détection automatique. */
export function clearManualHardware() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* stockage indisponible */
  }
  notify();
}

/**
 * Appelle cb quand le profil change.
 * @param {() => void} cb
 * @returns {() => void} désabonnement
 */
export function onHardwareChange(cb) {
  window.addEventListener(EVENT_NAME, cb);
  return () => window.removeEventListener(EVENT_NAME, cb);
}

/** @type {Map<string, Fit>} */
const fitCache = new Map();

/** Oublie les estimations mémorisées (profil d'un modèle modifié). */
export function clearFitCache() {
  fitCache.clear();
}
const FIT_VALUES = ['gpu', 'mixed', 'cpu', 'too-big'];

/**
 * Estimation précise via le moteur (couches GPU, cache KV…), avec repli sur {@link estimateFit}.
 * Ne rejette jamais. Sans méta ni modèle, hors Tauri, en cas d'erreur ou si le moteur ne sait pas : estimation grossière.
 * @param {{ modelId?: string, sizeBytes?: number, meta?: ArchMeta|null }} input
 * @param {{ ramBytes: number, vramBytes: number }} profile
 * @returns {Promise<Fit>}
 */
export async function estimateFitAsync({ modelId, sizeBytes, meta }, profile) {
  const fallback = () => estimateFit(sizeBytes || 0, profile);
  try {
    if (!engineAvailable() || (!modelId && !meta)) return fallback();
    /** @type {Record<string, unknown>} */
    const payload = {};
    if (modelId) payload.modelId = modelId;
    if (typeof sizeBytes === 'number') payload.sizeBytes = sizeBytes;
    if (meta) payload.meta = meta;
    payload.vramBytes = profile.vramBytes || 0;
    payload.ramBytes = profile.ramBytes || 0;
    const key = JSON.stringify(payload);
    const cached = fitCache.get(key);
    if (cached) return cached;
    const res = await invoke('engine_estimate', { input: payload });
    const r = /** @type {any} */ (res);
    if (r && r.known === true && FIT_VALUES.includes(r.fit)) {
      fitCache.set(key, r.fit);
      return r.fit;
    }
  } catch {
    /* repli ci-dessous */
  }
  return fallback();
}

/**
 * Estimation GROSSIÈRE (repli) : ce qu'un modèle de cette taille peut faire sur ce matériel.
 * Besoin = taille × 1,1 + 1 Gio (contexte et tampons). Ignore l'architecture réelle du modèle.
 * @param {number} sizeBytes
 * @param {{ ramBytes: number, vramBytes: number }} profile
 * @returns {Fit}
 */
export function estimateFit(sizeBytes, profile) {
  const need = sizeBytes * 1.1 + GIB;
  const vram = profile.vramBytes || 0;
  const ram = profile.ramBytes || 0;
  if (vram > 0 && need <= vram) return 'gpu';
  if (vram > 0 && need <= vram + 0.7 * ram) return 'mixed';
  if (vram <= 0 && need <= 0.7 * ram) return 'cpu';
  return 'too-big';
}

/** Taille lisible (Mo / Go) selon la langue courante. @param {number} bytes */
export function formatBytes(bytes) {
  const nf = (/** @type {number} */ n) =>
    new Intl.NumberFormat(getLang(), { maximumFractionDigits: n >= 100 ? 0 : 1 }).format(n);
  const gb = bytes / GIB;
  if (gb >= 1) return `${nf(gb)} ${t('settings.engine.unitGb')}`;
  return `${nf(bytes / 1024 ** 2)} ${t('settings.engine.unitMb')}`;
}

/** Classes complètes de chaque badge (jamais construites dynamiquement). */
const FIT_STYLE = {
  gpu: { cls: 'shrink-0 rounded-full border border-emerald-500/40 px-2 py-0.5 text-[11px] font-medium text-emerald-500', label: 'common.fit.gpu', hint: 'common.fit.gpuHint' },
  mixed: { cls: 'shrink-0 rounded-full border border-amber-500/40 px-2 py-0.5 text-[11px] font-medium text-amber-500', label: 'common.fit.mixed', hint: 'common.fit.mixedHint' },
  cpu: { cls: 'shrink-0 rounded-full border border-amber-500/40 px-2 py-0.5 text-[11px] font-medium text-amber-500', label: 'common.fit.cpu', hint: 'common.fit.cpuHint' },
  'too-big': { cls: 'shrink-0 rounded-full border border-danger/40 px-2 py-0.5 text-[11px] font-medium text-danger', label: 'common.fit.tooBig', hint: 'common.fit.tooBigHint' },
};

/**
 * Badge de compatibilité pour un fichier de cette taille.
 * @param {Fit} fit
 * @returns {HTMLElement}
 */
export function buildFitBadge(fit) {
  const style = FIT_STYLE[fit];
  const s = document.createElement('span');
  s.className = style.cls;
  s.dataset.fit = fit;
  s.textContent = t(style.label);
  s.title = t(style.hint);
  return s;
}

/**
 * Description courte du profil, ex. « RTX 5070 Laptop · 8 Go de VRAM · 32 Go de RAM ».
 * @param {HardwareProfile} p
 */
export function describeProfile(p) {
  if (!p.known) return t('common.hardware.unknown');
  const gpu =
    p.vramBytes > 0
      ? t('common.hardware.gpuVram', { name: p.gpuName || t('common.hardware.gpuGeneric'), vram: formatBytes(p.vramBytes) })
      : t('common.hardware.noGpu');
  return t('common.hardware.line', { gpu, ram: formatBytes(p.ramBytes) });
}
