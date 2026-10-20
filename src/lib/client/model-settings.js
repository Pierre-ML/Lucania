// Fenêtre « Réglages du modèle » (marquage : ModelSettingsDialog.astro, attributs data-ms) :
// options de chargement, estimation de la mémoire vidéo en direct et paramètres de génération, par modèle.
import { confirmDialog } from './dialog.js';
import {
  engineAvailable,
  estimateVram,
  getEngineStatus,
  getModelProfile,
  loadModel,
  resetModelProfile,
  setModelProfile,
  stopGeneration,
} from './engine.js';
import { clearFitCache, formatBytes, getHardwareProfile, onHardwareChange } from './hardware.js';
import { errorMessage } from './hf.js';
import { getLang, t } from './i18n.js';
import { isOn, setOn } from './switch-utils.js';

/** @typedef {import('./engine.js').ProfileInfo} ProfileInfo */
/** @typedef {import('./engine.js').VramEstimate} VramEstimate */
/** @typedef {import('./engine.js').SaveResult} SaveResult */
/** @typedef {import('./engine.js').LoadOptions} LoadOptions */
/** @typedef {import('./engine.js').GenParams} GenParams */
/**
 * Contraintes d'un champ numérique. int : entier ; min/max : bornes incluses.
 * @typedef {{ min?: number, max?: number, int?: boolean }} FieldSpec
 */

const DEBOUNCE_MS = 150;
const RELOAD_WAIT_MS = 250;
const RELOAD_WAIT_TRIES = 24;

/** Champs numériques du formulaire (clé = data-ms-field = clé du profil). @type {Record<string, FieldSpec>} */
const NUM_FIELDS = {
  nCtx: { min: 256, max: 1048576, int: true },
  nGpuLayers: { min: 0, max: 999, int: true },
  nThreads: { min: 1, max: 256, int: true },
  nBatch: { min: 32, max: 8192, int: true },
  temperature: { min: 0, max: 10 },
  topP: { min: 0, max: 1 },
  topK: { min: 0, int: true },
  minP: { min: 0, max: 1 },
  repeatPenalty: { min: 0.5, max: 2 },
  maxTokens: { min: 1, max: 131072, int: true },
  seed: { int: true },
};
const GEN_NUM_KEYS = ['temperature', 'topP', 'topK', 'minP', 'repeatPenalty', 'maxTokens', 'seed'];
const CACHE_TYPES = ['f16', 'q8_0', 'q4_0'];
/** Lignes de détail qui n'ont de sens qu'avec un moteur GPU. */
const GPU_ROWS = ['weights', 'kv', 'compute', 'layers'];

/** @type {HTMLDialogElement|null} */
let dlg = null;
/** Identifiant du modèle ouvert. */
let currentId = '';
/** @type {ProfileInfo|null} */
let info = null;
/** @type {VramEstimate|null} */
let estimate = null;
let busy = false;
/** Numéro de la dernière ouverture / lecture du profil (ignore les réponses périmées). */
let loadSeq = 0;
/** Numéro de la dernière estimation demandée. */
let estSeq = 0;
/** @type {ReturnType<typeof setTimeout>|undefined} */
let estTimer;
/** État brut du formulaire à l'ouverture (détecte les modifications non enregistrées). */
let snapshot = '';
let initialized = false;

// ---------- Accès au marquage ----------

/** Élément `[data-ms="name"]` de la fenêtre. @param {string} name */
const q = (name) => /** @type {HTMLElement} */ (/** @type {HTMLDialogElement} */ (dlg).querySelector(`[data-ms="${name}"]`));
/** Champ `[data-ms-field="key"]`. @param {string} key */
const fieldEl = (key) => /** @type {HTMLInputElement} */ (/** @type {HTMLDialogElement} */ (dlg).querySelector(`[data-ms-field="${key}"]`));
/** Valeur d'estimation `[data-ms-est="key"]`. @param {string} key */
const estEl = (key) => /** @type {HTMLElement} */ (/** @type {HTMLDialogElement} */ (dlg).querySelector(`[data-ms-est="${key}"]`));

/** @param {number} n */
const fmtInt = (n) => new Intl.NumberFormat(getLang()).format(n);

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Messages, état occupé ----------

/** Bandeau d'erreur en haut du contenu. @param {string} msg */
function setMessage(msg) {
  const el = q('message');
  el.textContent = msg;
  el.hidden = !msg;
}

/** Bandeau d'information (réglages enregistrés mais pas appliqués, etc.). @param {string} msg */
function setNotice(msg) {
  const el = q('notice');
  el.textContent = msg;
  el.hidden = !msg;
}

/**
 * Bloque ou libère le formulaire (enregistrement, rechargement du modèle).
 * @param {boolean} on
 * @param {string} [label] texte du bouton principal pendant l'opération
 */
function setBusy(on, label) {
  busy = on;
  /** @type {HTMLFieldSetElement} */ (q('fieldset')).disabled = on;
  /** @type {HTMLButtonElement} */ (q('cancel')).disabled = on;
  /** @type {HTMLButtonElement} */ (q('close')).disabled = on;
  const ready = Boolean(info);
  /** @type {HTMLButtonElement} */ (q('save')).disabled = on || !ready;
  /** @type {HTMLButtonElement} */ (q('reset')).disabled = on || !ready;
  q('saveLabel').textContent = on && label ? label : t('settings.modelSettings.save');
}

// ---------- Validation ----------

/**
 * Lit un champ numérique. Vide = valeur par défaut (null).
 * @param {string} key
 * @returns {{ value: number|null, error: string }}
 */
function parseField(key) {
  const el = fieldEl(key);
  const spec = NUM_FIELDS[key];
  if (el.validity.badInput) return { value: null, error: t('settings.modelSettings.errors.number') };
  const raw = el.value.trim();
  if (raw === '') return { value: null, error: '' };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { value: null, error: t('settings.modelSettings.errors.number') };
  if (spec.int && !Number.isInteger(n)) return { value: null, error: t('settings.modelSettings.errors.integer') };
  const { min, max } = spec;
  if (key === 'nCtx') {
    if (n !== 0 && (n < 256 || n > 1048576)) return { value: null, error: t('settings.modelSettings.errors.nCtx') };
  } else if (min !== undefined && max !== undefined) {
    if (n < min || n > max) return { value: null, error: t('settings.modelSettings.errors.range', { min: fmtInt(min), max: fmtInt(max) }) };
  } else if (min !== undefined && n < min) {
    return { value: null, error: t('settings.modelSettings.errors.min', { min: fmtInt(min) }) };
  }
  return { value: n, error: '' };
}

/** Affiche ou efface l'erreur d'un champ. @param {string} key @param {string} msg */
function setFieldError(key, msg) {
  const err = /** @type {HTMLElement|null} */ (/** @type {HTMLDialogElement} */ (dlg).querySelector(`[data-ms-error="${key}"]`));
  if (err) {
    err.textContent = msg;
    err.hidden = !msg;
  }
  const el = fieldEl(key);
  if (el) {
    if (msg) el.setAttribute('aria-invalid', 'true');
    else el.removeAttribute('aria-invalid');
  }
}

/** @param {Record<string, string>} errors */
function showErrors(errors) {
  for (const key of Object.keys(NUM_FIELDS)) setFieldError(key, errors[key] || '');
}

/**
 * Lit tout le formulaire et le traduit en profil (champ vide = null = défaut).
 * @returns {{ load: LoadOptions, gen: GenParams, errors: Record<string, string> }}
 */
function readForm() {
  /** @type {Record<string, string>} */
  const errors = {};
  /** @param {string} key */
  const num = (key) => {
    const r = parseField(key);
    if (r.error) errors[key] = r.error;
    return r.value;
  };
  const defaults = info ? info.defaults : null;

  /** @type {LoadOptions} */
  const load = {};
  if (/** @type {HTMLInputElement} */ (q('nCtxMax')).checked) load.nCtx = 0;
  else load.nCtx = num('nCtx');

  if (!info || !info.gpuBuild) load.nGpuLayers = info ? (info.profile.load.nGpuLayers ?? null) : null;
  else if (/** @type {HTMLInputElement} */ (q('gpuAuto')).checked) load.nGpuLayers = null;
  else load.nGpuLayers = num('nGpuLayers');

  load.nThreads = num('nThreads');
  load.nBatch = num('nBatch');

  const flash = isOn(q('flashAttn'));
  load.flashAttn = defaults && flash === defaults.load.flashAttn ? null : flash;

  const cache = /** @type {HTMLSelectElement} */ (q('cache')).value;
  const cacheValue = CACHE_TYPES.includes(cache) ? /** @type {'f16'|'q8_0'|'q4_0'} */ (cache) : 'f16';
  const cacheOrNull = defaults && cacheValue === defaults.load.cacheTypeK ? null : cacheValue;
  load.cacheTypeK = cacheOrNull;
  load.cacheTypeV = cacheOrNull;

  /** @type {GenParams} */
  const gen = {};
  for (const key of GEN_NUM_KEYS) gen[/** @type {'temperature'} */ (key)] = num(key);
  const prompt = fieldEl('systemPrompt').value;
  gen.systemPrompt = prompt.trim() ? prompt : null;

  return { load, gen, errors };
}

/** Options de chargement pour l'estimation : un champ invalide compte comme « défaut ». @returns {LoadOptions} */
function loadForEstimate() {
  const { load, errors } = readForm();
  /** @type {Record<string, unknown>} */
  const out = { ...load };
  for (const key of Object.keys(errors)) if (key in out) out[key] = null;
  return out;
}

/** État brut de tous les champs, pour détecter les modifications. */
function rawState() {
  if (!dlg) return '';
  const auto = /** @type {HTMLInputElement} */ (q('gpuAuto')).checked;
  // En mode automatique, le champ des couches affiche l'estimation : il ne compte pas comme une saisie.
  const fields = [...dlg.querySelectorAll('[data-ms-field]')].map((el) => {
    const input = /** @type {HTMLInputElement} */ (el);
    return auto && input.dataset.msField === 'nGpuLayers' ? '' : input.value;
  });
  return JSON.stringify([
    fields,
    /** @type {HTMLInputElement} */ (q('nCtxMax')).checked,
    auto,
    isOn(q('flashAttn')),
    /** @type {HTMLSelectElement} */ (q('cache')).value,
  ]);
}

// ---------- Remplissage du formulaire ----------

/** @param {string} key @param {unknown} value */
function setVal(key, value) {
  fieldEl(key).value = value === null || value === undefined ? '' : String(value);
}

/** @param {string} key @param {string} text */
function setPlaceholder(key, text) {
  fieldEl(key).placeholder = text;
}

/** Contexte : case « Maximum du modèle » et champ associé. */
function syncCtx() {
  if (!info) return;
  const max = /** @type {HTMLInputElement} */ (q('nCtxMax')).checked;
  const input = fieldEl('nCtx');
  input.disabled = max;
  if (max) {
    input.value = '';
    setFieldError('nCtx', '');
  }
  const ctxLen = info.meta && info.meta.contextLength;
  input.placeholder = max && ctxLen ? fmtInt(ctxLen) : String(info.defaults.load.nCtx);
}

/** Couches GPU : mode automatique / manuel, bornes et aide. */
function syncGpu() {
  if (!info) return;
  const gpu = info.gpuBuild;
  const auto = /** @type {HTMLInputElement} */ (q('gpuAuto'));
  const range = /** @type {HTMLInputElement} */ (q('gpuRange'));
  const number = fieldEl('nGpuLayers');
  const blocks = info.meta && info.meta.blockCount ? info.meta.blockCount : null;
  q('gpuAutoWrap').hidden = !gpu;
  q('gpuControls').hidden = !gpu;
  const manual = gpu && !auto.checked;
  range.disabled = !manual;
  number.disabled = !manual;
  range.hidden = blocks === null;
  if (blocks !== null) {
    range.max = String(blocks);
    number.max = String(blocks);
  }
  const hintEl = q('gpuHint');
  if (!gpu) hintEl.textContent = t('settings.modelSettings.load.cpuOnly');
  else if (blocks !== null) hintEl.textContent = t('settings.modelSettings.load.gpuHint', { total: blocks });
  else hintEl.textContent = t('settings.modelSettings.load.gpuHintUnknown');
  if (!manual) setFieldError('nGpuLayers', '');
}

/** Pose le nombre de couches affiché (champ et curseur). @param {number} n */
function showGpuLayers(n) {
  fieldEl('nGpuLayers').value = String(n);
  /** @type {HTMLInputElement} */ (q('gpuRange')).value = String(n);
}

/** Remplit le formulaire avec le profil reçu du moteur. @param {ProfileInfo} i */
function applyInfo(i) {
  const { profile, defaults, meta } = i;
  const pl = profile.load || {};
  const pg = profile.gen || {};

  const ctxMax = pl.nCtx === 0;
  /** @type {HTMLInputElement} */ (q('nCtxMax')).checked = ctxMax;
  setVal('nCtx', ctxMax ? '' : pl.nCtx);
  const ctxLen = meta && meta.contextLength;
  q('nCtxHint').textContent = ctxLen
    ? `${t('settings.modelSettings.load.nCtxMaxHint', { n: fmtInt(ctxLen) })} ${t('settings.modelSettings.load.nCtxHint')}`
    : t('settings.modelSettings.load.nCtxHint');
  syncCtx();

  const auto = pl.nGpuLayers === null || pl.nGpuLayers === undefined;
  /** @type {HTMLInputElement} */ (q('gpuAuto')).checked = auto || !i.gpuBuild;
  setVal('nGpuLayers', auto ? '' : pl.nGpuLayers);
  /** @type {HTMLInputElement} */ (q('gpuRange')).value = auto ? '0' : String(pl.nGpuLayers);
  syncGpu();

  setVal('nThreads', pl.nThreads);
  setPlaceholder('nThreads', String(defaults.load.nThreads));
  setVal('nBatch', pl.nBatch);
  setPlaceholder('nBatch', String(defaults.load.nBatch));
  setOn(q('flashAttn'), pl.flashAttn ?? defaults.load.flashAttn);
  const cache = pl.cacheTypeK || pl.cacheTypeV || defaults.load.cacheTypeK;
  /** @type {HTMLSelectElement} */ (q('cache')).value = CACHE_TYPES.includes(cache) ? cache : 'f16';

  for (const key of GEN_NUM_KEYS) {
    setVal(key, pg[/** @type {'temperature'} */ (key)]);
    const def = defaults.gen[/** @type {'temperature'} */ (key)];
    setPlaceholder(key, def === null || def === undefined ? t('settings.modelSettings.gen.seedPlaceholder') : String(def));
  }
  setVal('systemPrompt', pg.systemPrompt || '');
  setPlaceholder('systemPrompt', defaults.gen.systemPrompt || t('settings.modelSettings.gen.systemPromptPlaceholder'));

  showErrors({});
  q('autoFit').toggleAttribute('disabled', !i.gpuBuild);
  q('autoFitAlert').toggleAttribute('disabled', !i.gpuBuild);
  snapshot = rawState();
}

// ---------- Estimation de la mémoire ----------

function scheduleEstimate() {
  clearTimeout(estTimer);
  estTimer = setTimeout(runEstimate, DEBOUNCE_MS);
}

async function runEstimate() {
  if (!dlg || !dlg.open || !info) return;
  const id = currentId;
  const seq = ++estSeq;
  const options = loadForEstimate();
  /** @type {{ vramBytes: number, ramBytes: number }} */
  let hw = { vramBytes: 0, ramBytes: 0 };
  try {
    hw = await getHardwareProfile();
  } catch {
    /* matériel inconnu : le moteur estimera sans VRAM */
  }
  try {
    const est = await estimateVram({ modelId: id, options, vramBytes: hw.vramBytes || 0, ramBytes: hw.ramBytes || 0 });
    if (seq !== estSeq || id !== currentId) return;
    estimate = est;
    renderEstimate(est);
  } catch (e) {
    if (seq !== estSeq || id !== currentId) return;
    estimate = null;
    showEstimateStatus(t('settings.modelSettings.estimate.error', { message: errorMessage(e) }));
  }
}

/** Affiche un message à la place du détail de l'estimation. @param {string} text */
function showEstimateStatus(text) {
  const status = q('estStatus');
  status.textContent = text;
  status.hidden = false;
  q('estBody').hidden = true;
}

/** @param {VramEstimate} est */
function renderEstimate(est) {
  if (!info) return;
  if (!est || !est.known) {
    showEstimateStatus(t('settings.modelSettings.estimate.unknown'));
    return;
  }
  q('estStatus').hidden = true;
  q('estBody').hidden = false;
  const gpu = info.gpuBuild;
  const vram = est.vramBytes > 0 ? est.vramBytes : 0;

  q('gpuCard').hidden = !gpu;
  estEl('total').textContent = vram > 0 ? `${formatBytes(est.totalGpuBytes)} / ${formatBytes(vram)}` : formatBytes(est.totalGpuBytes);
  const pct = vram > 0 ? Math.min(100, Math.round((est.totalGpuBytes / vram) * 100)) : 0;
  const gauge = q('gauge');
  gauge.style.width = `${pct}%`;
  gauge.dataset.over = String(!est.fits);
  q('vramUnknown').hidden = !(gpu && vram <= 0);

  estEl('weights').textContent = formatBytes(est.weightsGpuBytes);
  estEl('kv').textContent = formatBytes(est.kvGpuBytes);
  estEl('compute').textContent = formatBytes(est.computeBytes);
  estEl('layers').textContent =
    est.blockCount !== null && est.blockCount !== undefined
      ? t('settings.modelSettings.estimate.layersValue', { gpu: est.gpuLayers, total: est.blockCount })
      : String(est.gpuLayers);
  const ramUsed = formatBytes(est.weightsCpuBytes + est.kvCpuBytes);
  estEl('ram').textContent = est.ramBytes > 0 ? `${ramUsed} / ${formatBytes(est.ramBytes)}` : ramUsed;
  const maxRow = /** @type {HTMLElement} */ (/** @type {HTMLDialogElement} */ (dlg).querySelector('[data-ms-row="maxContext"]'));
  maxRow.hidden = est.maxContext === null || est.maxContext === undefined;
  if (!maxRow.hidden) estEl('maxContext').textContent = fmtInt(/** @type {number} */ (est.maxContext));
  for (const key of GPU_ROWS) {
    const row = /** @type {HTMLElement} */ (/** @type {HTMLDialogElement} */ (dlg).querySelector(`[data-ms-row="${key}"]`));
    row.hidden = !gpu;
  }

  q('alert').hidden = est.fits;
  q('alertTitle').textContent = t(gpu && vram > 0 ? 'settings.modelSettings.estimate.notFitsVram' : 'settings.modelSettings.estimate.notFitsMemory');

  const loadedEl = q('loadedLayers');
  const showLoaded = info.loaded && info.loadedGpuLayers !== null && info.loadedGpuLayers !== undefined;
  loadedEl.hidden = !showLoaded;
  if (showLoaded) loadedEl.textContent = t('settings.modelSettings.estimate.loadedLayers', { count: info.loadedGpuLayers });

  // En mode automatique, les champs montrent ce que le moteur choisirait.
  if (gpu && /** @type {HTMLInputElement} */ (q('gpuAuto')).checked) showGpuLayers(est.gpuLayers);
}

/** « Ajuster automatiquement » : fixe le nombre de couches GPU à ce que le moteur choisirait. */
function adjustAuto() {
  if (!info || !info.gpuBuild || !estimate || !estimate.known) return;
  /** @type {HTMLInputElement} */ (q('gpuAuto')).checked = false;
  syncGpu();
  showGpuLayers(estimate.autoGpuLayers);
  setFieldError('nGpuLayers', '');
  runEstimate();
}

// ---------- Enregistrement, réinitialisation, rechargement ----------

/**
 * Si le profil enregistré change le chargement d'un modèle déjà chargé, le recharge
 * (en demandant confirmation si une génération est en cours).
 * @param {string} id
 * @param {SaveResult} res
 * @returns {Promise<'none'|'reloaded'|'deferred'>}
 */
async function applyReload(id, res) {
  if (!res || !res.loaded || !res.loadChanged) return 'none';
  let generating = false;
  try {
    generating = (await getEngineStatus()).generating;
  } catch {
    /* état inconnu : on suppose qu'aucune génération n'est en cours */
  }
  if (generating) {
    const ok = await confirmDialog({
      title: t('settings.modelSettings.reload.title'),
      message: t('settings.modelSettings.reload.message'),
      confirmLabel: t('settings.modelSettings.reload.confirm'),
      danger: false,
    });
    if (!ok) return 'deferred';
    setBusy(true, t('settings.modelSettings.reloading'));
    await stopGeneration();
    for (let i = 0; i < RELOAD_WAIT_TRIES; i++) {
      let still = false;
      try {
        still = (await getEngineStatus()).generating;
      } catch {
        still = false;
      }
      if (!still) break;
      await sleep(RELOAD_WAIT_MS);
    }
  }
  setBusy(true, t('settings.modelSettings.reloading'));
  await loadModel(id);
  return 'reloaded';
}

/** @param {SubmitEvent|Event} e */
async function onSubmit(e) {
  e.preventDefault();
  if (busy || !info || !dlg) return;
  setMessage('');
  setNotice('');
  const { load, gen, errors } = readForm();
  showErrors(errors);
  const first = Object.keys(errors)[0];
  if (first) {
    fieldEl(first).focus();
    return;
  }
  const id = currentId;
  setBusy(true, t('settings.modelSettings.saving'));
  try {
    const res = await setModelProfile(id, { load, gen });
    clearFitCache();
    const outcome = await applyReload(id, res);
    if (outcome === 'deferred') {
      snapshot = rawState();
      setNotice(t('settings.modelSettings.savedLater'));
    } else if (id === currentId) {
      dlg.close();
    }
  } catch (err) {
    setMessage(errorMessage(err));
  } finally {
    setBusy(false);
  }
}

async function onReset() {
  if (busy || !info) return;
  setMessage('');
  setNotice('');
  const id = currentId;
  setBusy(true);
  try {
    const res = await resetModelProfile(id);
    clearFitCache();
    const outcome = await applyReload(id, res);
    const fresh = await getModelProfile(id);
    if (id !== currentId) return;
    info = fresh;
    applyInfo(fresh);
    setNotice(t(outcome === 'deferred' ? 'settings.modelSettings.savedLater' : 'settings.modelSettings.resetDone'));
    runEstimate();
  } catch (err) {
    setMessage(errorMessage(err));
  } finally {
    setBusy(false);
  }
}

// ---------- Ouverture ----------

/** Lit le profil du modèle ouvert et affiche le formulaire. */
async function loadInfo() {
  const id = currentId;
  const seq = ++loadSeq;
  try {
    const fresh = await getModelProfile(id);
    if (seq !== loadSeq) return;
    info = fresh;
    applyInfo(fresh);
    q('loading').hidden = true;
    q('fieldset').hidden = false;
    setBusy(false);
    runEstimate();
  } catch (e) {
    if (seq !== loadSeq) return;
    q('loading').hidden = true;
    setMessage(errorMessage(e));
  }
}

/**
 * Ouvre la fenêtre de réglages d'un modèle installé.
 * @param {string} modelId identifiant moteur du modèle
 * @param {string} [displayName] nom affiché (sinon l'identifiant)
 */
export function openModelSettings(modelId, displayName) {
  if (!dlg || !modelId) return;
  currentId = modelId;
  info = null;
  estimate = null;
  loadSeq++;
  estSeq++;
  clearTimeout(estTimer);

  const nameEl = q('model-name');
  nameEl.textContent = displayName || modelId;
  nameEl.title = modelId;
  setMessage('');
  setNotice('');
  const loading = q('loading');
  loading.textContent = t('settings.modelSettings.loading');
  loading.hidden = false;
  q('fieldset').hidden = true;
  showEstimateStatus(t('settings.modelSettings.estimate.pending'));
  setBusy(false);
  if (!dlg.open) dlg.showModal();

  if (!engineAvailable()) {
    loading.textContent = t('chat.engine.unavailable');
    return;
  }
  loadInfo();
}

/** Branche la fenêtre « Réglages du modèle » (à appeler une fois au démarrage de la page). */
export function initModelSettings() {
  if (initialized) return;
  const el = /** @type {HTMLDialogElement|null} */ (document.getElementById('model-settings-dialog'));
  if (!el) return;
  initialized = true;
  dlg = el;
  const form = /** @type {HTMLFormElement} */ (q('form'));

  form.addEventListener('submit', onSubmit);
  q('reset').addEventListener('click', onReset);
  q('cancel').addEventListener('click', () => {
    if (!busy) el.close();
  });
  q('close').addEventListener('click', () => {
    if (!busy) el.close();
  });
  q('autoFit').addEventListener('click', adjustAuto);
  q('autoFitAlert').addEventListener('click', adjustAuto);
  q('hwLink').addEventListener('click', () => el.close());

  el.addEventListener('cancel', (e) => {
    if (busy) e.preventDefault();
  });
  el.addEventListener('click', (e) => {
    if (e.target === el && !busy && rawState() === snapshot) el.close();
  });
  el.addEventListener('close', () => {
    loadSeq++;
    estSeq++;
    clearTimeout(estTimer);
    info = null;
    estimate = null;
  });

  // Commandes qui agissent sur d'autres champs.
  q('nCtxMax').addEventListener('change', syncCtx);
  q('gpuAuto').addEventListener('change', () => {
    syncGpu();
    const number = fieldEl('nGpuLayers');
    if (!/** @type {HTMLInputElement} */ (q('gpuAuto')).checked && number.value.trim() === '') {
      showGpuLayers(estimate ? estimate.gpuLayers : 0);
    }
  });
  q('gpuRange').addEventListener('input', () => {
    fieldEl('nGpuLayers').value = /** @type {HTMLInputElement} */ (q('gpuRange')).value;
    setFieldError('nGpuLayers', '');
  });
  fieldEl('nGpuLayers').addEventListener('input', () => {
    const n = Number(fieldEl('nGpuLayers').value);
    if (fieldEl('nGpuLayers').value.trim() !== '' && Number.isFinite(n)) {
      /** @type {HTMLInputElement} */ (q('gpuRange')).value = String(n);
    }
  });
  q('flashAttn').addEventListener('click', () => {
    setOn(q('flashAttn'), !isOn(q('flashAttn')));
    scheduleEstimate();
  });

  // Validation à la saisie / à la sortie du champ ; toute modification relance l'estimation.
  form.addEventListener('input', (e) => {
    const key = /** @type {HTMLElement} */ (e.target).dataset.msField;
    if (key && key in NUM_FIELDS) setFieldError(key, '');
    scheduleEstimate();
  });
  form.addEventListener('change', (e) => {
    const key = /** @type {HTMLElement} */ (e.target).dataset.msField;
    if (key && key in NUM_FIELDS && !fieldEl(key).disabled) setFieldError(key, parseField(key).error);
    scheduleEstimate();
  });

  onHardwareChange(() => {
    if (el.open) scheduleEstimate();
  });
}
