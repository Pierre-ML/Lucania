// Page Paramètres : navigation par sections, moteur local, apparence/langue, à propos.
// Connexions, accès distant et extinction vivent sur la page /connexion.
import {
  engineAvailable,
  getCrashLogs,
  getEngineInfo,
  getEngineStatus,
  listModels,
  onEngineStatus,
  openCrashLogs,
  useModel,
  unloadModel,
  deleteModel,
} from './engine.js';
import { errorMessage, onDownload } from './hf.js';
import {
  GPU_PRESETS,
  RAM_OPTIONS_GB,
  buildFitBadge,
  describeProfile,
  estimateFitAsync,
  formatBytes,
  getDetectedHardware,
  isRemoteMode,
  getManualHardware,
  onHardwareChange,
  clearManualHardware,
  setManualHardware,
} from './hardware.js';
import { invoke } from '@tauri-apps/api/core';
import { confirmDialog } from './dialog.js';
import { openModelSettings } from './model-settings.js';
import { t, getLang, setLang } from './i18n.js';
import { THEMES, getTheme, setTheme } from './theme.js';

/** @param {string} sel @param {ParentNode} [root] */
const $ = (sel, root = document) => root.querySelector(sel);
/** @param {string} id */
const byId = (id) => document.getElementById(id);

// Anciennes ancres des sections déplacées vers la page /connexion.
if (['connexions', 'acces-distant', 'extinction'].includes(location.hash.slice(1))) {
  location.replace('/connexion');
}

// ---------- Navigation par sections (#moteur, #apparence, #a-propos…) ----------

/** @type {HTMLElement[]} */
const panels = [...document.querySelectorAll('[data-panel]')];
/** @type {HTMLElement[]} */
const navLinks = [...document.querySelectorAll('[data-nav]')];
const DEFAULT_PANEL = 'moteur';

function showPanel() {
  let wanted = '';
  try {
    wanted = decodeURIComponent(location.hash.slice(1));
  } catch {
    wanted = '';
  }
  const id = panels.some((p) => p.dataset.panel === wanted) ? wanted : DEFAULT_PANEL;
  for (const p of panels) p.hidden = p.dataset.panel !== id;
  for (const a of navLinks) {
    if (a.dataset.nav === id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}
window.addEventListener('hashchange', showPanel);
showPanel();

// ---------- Apparence : thème et langue ----------

const themeGrid = byId('theme-grid');
const tplTheme = /** @type {HTMLTemplateElement} */ (byId('tpl-theme'));

/** Bloc d'aperçu : porte son propre data-theme, daisyUI y applique les couleurs du thème.
 * @param {string} id @param {string} [extra] */
function buildPreview(id, extra = '') {
  const box = document.createElement('span');
  box.dataset.theme = id;
  box.className = `absolute inset-0 flex bg-base-100 ${extra}`;
  const side = document.createElement('span');
  side.className = 'w-1/4 bg-base-200';
  const main = document.createElement('span');
  main.className = 'flex min-w-0 flex-1 flex-col justify-between p-2';
  const bubble = document.createElement('span');
  bubble.className = 'block h-4 w-3/4 rounded-md bg-base-300';
  const lines = document.createElement('span');
  lines.className = 'block h-1.5 w-1/2 rounded-full bg-base-content/40';
  const dots = document.createElement('span');
  dots.className = 'flex gap-1';
  for (const c of ['bg-primary', 'bg-accent']) {
    const dot = document.createElement('span');
    dot.className = `block size-3 rounded-full ${c}`;
    dots.append(dot);
  }
  const top = document.createElement('span');
  top.className = 'flex flex-col gap-1.5';
  top.append(bubble, lines);
  main.append(top, dots);
  box.append(side, main);
  return box;
}

function renderThemes() {
  if (!themeGrid) return;
  const lang = getLang();
  const current = getTheme();
  for (const theme of THEMES) {
    const frag = /** @type {DocumentFragment} */ (tplTheme.content.cloneNode(true));
    const card = /** @type {HTMLButtonElement} */ ($('[data-theme-card]', frag));
    card.dataset.themeId = theme.id;
    card.setAttribute('aria-checked', theme.id === current ? 'true' : 'false');
    card.tabIndex = theme.id === current ? 0 : -1;
    const preview = $('[data-preview]', frag);
    if (theme.id === 'system') {
      preview.prepend(buildPreview('light'), buildPreview('dark', '[clip-path:inset(0_0_0_50%)]'));
    } else {
      preview.prepend(buildPreview(theme.id));
    }
    $('[data-label]', frag).textContent = theme.label[lang] || theme.label.fr || theme.id;
    card.addEventListener('click', () => pickTheme(theme.id));
    themeGrid.append(frag);
  }
  if (!themeGrid.querySelector('[tabindex="0"]')) {
    const first = /** @type {HTMLElement|null} */ (themeGrid.querySelector('[data-theme-card]'));
    if (first) first.tabIndex = 0;
  }
}

/** @param {string} id */
function pickTheme(id) {
  setTheme(id);
  for (const card of /** @type {NodeListOf<HTMLElement>} */ (themeGrid.querySelectorAll('[data-theme-card]'))) {
    const on = card.dataset.themeId === id;
    card.setAttribute('aria-checked', on ? 'true' : 'false');
    card.tabIndex = on ? 0 : -1;
  }
}

themeGrid?.addEventListener('keydown', (e) => {
  const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
  if (!keys.includes(e.key)) return;
  const cards = /** @type {HTMLElement[]} */ ([...themeGrid.querySelectorAll('[data-theme-card]')]);
  const i = cards.indexOf(/** @type {HTMLElement} */ (document.activeElement));
  if (i < 0) return;
  e.preventDefault();
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
  const next = cards[(i + step + cards.length) % cards.length];
  next.focus();
  pickTheme(/** @type {string} */ (next.dataset.themeId));
});

renderThemes();

for (const btn of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-lang]'))) {
  btn.addEventListener('click', () => {
    const next = btn.dataset.lang;
    if (next && next !== getLang()) setLang(next);
  });
}

// ---------- Moteur : backend, dossier des modèles, modèles installés ----------

const engineUnavailableEl = byId('engine-unavailable');
const engineErrorEl = byId('engine-error');
const engineInfoEl = byId('engine-info');
const engineLoadingEl = byId('engine-loading');
const engineBackendEl = byId('engine-backend');
const engineDirEl = byId('engine-dir');
const engineModelsEl = byId('engine-models');
const engineEmptyEl = byId('engine-empty');
const engineRefreshBtn = /** @type {HTMLButtonElement|null} */ (byId('engine-refresh'));

const modelBtn = 'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border px-3 text-xs font-medium text-fg transition-[background-color,transform] duration-150 hover:bg-fg/5 focus-visible:outline-fg/40 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none';
const modelBtnDanger = 'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-danger/40 px-3 text-xs font-medium text-danger transition-[background-color,transform] duration-150 hover:bg-fg/5 focus-visible:outline-fg/40 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none';

/** @type {{ id: string, name: string, sizeBytes: number }[]} */
let engineModels = [];
/** @type {string|null} */
let loadedModelId = null;
/** Modèle en cours de chargement lancé depuis cette page. @type {string|null} */
let loadingModelId = null;
let engineLoadingAny = false;
let engineSubscribed = false;
/** Profil matériel utilisé pour les badges de compatibilité (null tant que la détection n'a pas répondu). @type {import('./hardware.js').HardwareProfile|null} */
let hwProfile = null;

/** @param {string} msg */
function showEngineError(msg) {
  if (!engineErrorEl) return;
  engineErrorEl.textContent = msg;
  engineErrorEl.hidden = !msg;
}

/** @param {string} id */
async function useEngineModel(id) {
  showEngineError('');
  loadingModelId = id;
  renderModels();
  try {
    await useModel(id);
    loadedModelId = id;
  } catch (e) {
    showEngineError(errorMessage(e));
  } finally {
    loadingModelId = null;
    renderModels();
  }
}

async function unloadEngineModel() {
  showEngineError('');
  try {
    await unloadModel();
    loadedModelId = null;
  } catch (e) {
    showEngineError(errorMessage(e));
  }
  renderModels();
}

/** @param {{ id: string, name: string }} model */
async function deleteEngineModel(model) {
  showEngineError('');
  const ok = await confirmDialog({
    title: t('settings.engine.delete.title'),
    message: t('settings.engine.delete.message', { name: model.name }),
  });
  if (!ok) return;
  try {
    await deleteModel(model.id);
    if (loadedModelId === model.id) loadedModelId = null;
    try {
      if (localStorage.getItem('lastModel') === 'local::' + model.id) localStorage.removeItem('lastModel');
    } catch {
      /* stockage indisponible */
    }
  } catch (e) {
    showEngineError(errorMessage(e));
  }
  await refreshModels();
}

/** @param {string} label @param {string} cls @param {() => void} onClick @param {boolean} disabled */
function buildModelBtn(label, cls, onClick, disabled) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

/** @param {{ id: string, name: string, sizeBytes: number }} model */
function buildModelItem(model) {
  const li = document.createElement('li');
  li.className = 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3';
  const isLoaded = loadedModelId === model.id;
  const isLoading = loadingModelId === model.id;
  const locked = loadingModelId !== null || engineLoadingAny;

  const info = document.createElement('div');
  info.className = 'min-w-0 flex-1';
  const head = document.createElement('div');
  head.className = 'flex min-w-0 items-center gap-2';
  const name = document.createElement('span');
  name.className = 'min-w-0 truncate font-mono text-sm';
  name.textContent = model.name;
  head.append(name);
  if (isLoaded) {
    const badge = document.createElement('span');
    badge.className = 'shrink-0 rounded-full bg-fg/10 px-2 py-0.5 text-[11px] font-medium text-fg';
    badge.textContent = t('settings.engine.loaded');
    head.append(badge);
  }
  if (hwProfile && hwProfile.known) {
    // Emplacement rempli dès que l'estimation du moteur répond (repli grossier géré par estimateFitAsync).
    const fitSlot = document.createElement('span');
    fitSlot.className = 'contents';
    head.append(fitSlot);
    estimateFitAsync({ modelId: model.id, sizeBytes: model.sizeBytes }, hwProfile)
      .then((fit) => {
        if (fitSlot.isConnected) fitSlot.replaceChildren(buildFitBadge(fit));
      })
      .catch(() => {
        /* pas de badge si l'estimation échoue */
      });
  }
  const meta = document.createElement('p');
  meta.className = 'mt-0.5 truncate font-mono text-[11px] text-muted';
  meta.textContent = `${formatBytes(model.sizeBytes)} · ${model.id}`;
  meta.title = model.id;
  info.append(head, meta);

  const actions = document.createElement('div');
  actions.className = 'flex shrink-0 items-center gap-2';
  actions.append(
    buildModelBtn(
      t(isLoading ? 'settings.engine.loading' : 'settings.engine.use'),
      modelBtn,
      () => useEngineModel(model.id),
      locked,
    ),
  );
  actions.append(
    buildModelBtn(t('settings.modelSettings.open'), modelBtn, () => openModelSettings(model.id, model.name), false),
  );
  if (isLoaded) actions.append(buildModelBtn(t('settings.engine.unload'), modelBtn, unloadEngineModel, locked));
  actions.append(buildModelBtn(t('settings.engine.delete.button'), modelBtnDanger, () => deleteEngineModel(model), locked));

  li.append(info, actions);
  return li;
}

function renderModels() {
  if (!engineModelsEl || !engineEmptyEl) return;
  engineModelsEl.replaceChildren(...engineModels.map(buildModelItem));
  engineModelsEl.hidden = engineModels.length === 0;
  engineEmptyEl.hidden = engineModels.length > 0;
}

async function refreshModels() {
  try {
    engineModels = await listModels();
    try {
      const st = await getEngineStatus();
      loadedModelId = st.loadedModel;
      engineLoadingAny = st.loading;
    } catch {
      /* l'état sera mis à jour par les événements */
    }
  } catch (e) {
    showEngineError(errorMessage(e));
  }
  renderModels();
}

async function subscribeEngine() {
  if (engineSubscribed) return;
  engineSubscribed = true;
  try {
    await onEngineStatus((st) => {
      loadedModelId = st.loadedModel;
      engineLoadingAny = st.loading;
      renderModels();
    });
    await onDownload((d) => {
      if (d.state === 'completed') refreshModels();
    });
  } catch {
    /* pas d'événements : le bouton Actualiser reste disponible */
  }
}

async function loadEngine() {
  if (!engineInfoEl || !engineUnavailableEl || !engineErrorEl || !engineLoadingEl || !engineBackendEl || !engineDirEl || !engineModelsEl || !engineEmptyEl) return;
  showEngineError('');
  if (!engineAvailable()) {
    engineLoadingEl.hidden = true;
    engineInfoEl.hidden = true;
    engineUnavailableEl.textContent = t('chat.engine.unavailable');
    engineUnavailableEl.hidden = false;
    if (engineRefreshBtn) engineRefreshBtn.hidden = true;
    return;
  }
  if (engineRefreshBtn) engineRefreshBtn.disabled = true;
  try {
    const [info] = await Promise.all([getEngineInfo(), refreshModels()]);
    engineBackendEl.textContent = t(info.backend === 'cuda' ? 'settings.engine.backendCuda' : 'settings.engine.backendCpu');
    engineDirEl.textContent = info.modelsDir;
    engineInfoEl.hidden = false;
    subscribeEngine();
    loadCrashLogs();
  } catch (e) {
    showEngineError(errorMessage(e));
  } finally {
    engineLoadingEl.hidden = true;
    if (engineRefreshBtn) engineRefreshBtn.disabled = false;
  }
}

/** Ligne « Journaux de plantage » : masquée si la commande échoue, sans gêner le reste de la section. */
async function loadCrashLogs() {
  const row = byId('engine-crash-row');
  const countEl = byId('engine-crash-count');
  const dirEl = byId('engine-crash-dir');
  if (!row || !countEl || !dirEl) return;
  try {
    const logs = await getCrashLogs();
    if (!logs || typeof logs.dir !== 'string') throw new Error('invalid');
    const count = Array.isArray(logs.files) ? logs.files.length : 0;
    countEl.textContent = t('settings.engine.crashLogs.count', { count });
    dirEl.textContent = logs.dir;
    row.hidden = false;
  } catch {
    row.hidden = true;
  }
}

byId('engine-crash-open')?.addEventListener('click', async (e) => {
  const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
  btn.disabled = true;
  try {
    await openCrashLogs();
  } catch (err) {
    showEngineError(errorMessage(err));
  } finally {
    btn.disabled = false;
  }
});

engineRefreshBtn?.addEventListener('click', loadEngine);

// ---------- Moteur : mon matériel (détecté ou saisi à la main) ----------

const hwTitleEl = byId('hw-title');
const hwDescEl = byId('hw-description');
const hwRamEl = byId('hw-ram');
const hwGpuEl = byId('hw-gpu');
const hwUsedEl = byId('hw-used');
const hwToggleBtn = /** @type {HTMLButtonElement|null} */ (byId('hw-manual-toggle'));
const hwFormEl = byId('hw-form');
const hwRamSelect = /** @type {HTMLSelectElement|null} */ (byId('hw-ram-select'));
const hwGpuSelect = /** @type {HTMLSelectElement|null} */ (byId('hw-gpu-select'));
const hwVramWrap = byId('hw-vram-wrap');
const hwVramInput = /** @type {HTMLInputElement|null} */ (byId('hw-vram-input'));
const hwErrorEl = byId('hw-error');
const hwSaveBtn = byId('hw-save');
const hwResetBtn = byId('hw-reset');
const HW_NONE = 'none';
const HW_OTHER = 'other';
const GIB = 1024 ** 3;

/** @param {string} value @param {string} label */
function hwOption(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

function buildHardwareOptions() {
  if (!hwRamSelect || !hwGpuSelect) return;
  const gb = t('settings.engine.unitGb');
  hwRamSelect.replaceChildren(...RAM_OPTIONS_GB.map((n) => hwOption(String(n), `${n} ${gb}`)));
  hwGpuSelect.replaceChildren(
    hwOption(HW_NONE, t('settings.engine.hardware.noGpuOption')),
    ...GPU_PRESETS.map((g, i) => hwOption(String(i), `${g.name} · ${g.vramGb} ${gb}`)),
    hwOption(HW_OTHER, t('settings.engine.hardware.otherGpu')),
  );
}

/** @param {string} msg */
function setHwError(msg) {
  if (!hwErrorEl) return;
  hwErrorEl.textContent = msg;
  hwErrorEl.hidden = !msg;
}

function syncVramField() {
  if (hwVramWrap && hwGpuSelect) hwVramWrap.hidden = hwGpuSelect.value !== HW_OTHER;
}

/** Préremplit le formulaire avec le profil manuel, sinon avec les valeurs détectées. */
async function fillHardwareForm() {
  if (!hwRamSelect || !hwGpuSelect || !hwVramInput) return;
  const manual = getManualHardware();
  const base = manual || (await getDetectedHardware());
  const ramGb = base.ramBytes / GIB;
  if (ramGb > 0) {
    let best = RAM_OPTIONS_GB[0];
    for (const n of RAM_OPTIONS_GB) if (Math.abs(n - ramGb) < Math.abs(best - ramGb)) best = n;
    hwRamSelect.value = String(best);
  }
  const vramGb = Math.round(base.vramBytes / GIB);
  const preset = GPU_PRESETS.findIndex((g) => g.vramGb === vramGb && g.name === base.gpuName);
  if (vramGb <= 0) hwGpuSelect.value = HW_NONE;
  else if (preset >= 0) hwGpuSelect.value = String(preset);
  else {
    hwGpuSelect.value = HW_OTHER;
    hwVramInput.value = String(vramGb);
  }
  syncVramField();
}

async function loadHardware() {
  if (!hwRamEl || !hwGpuEl || !hwUsedEl) return;
  const remote = await isRemoteMode();
  const detected = await getDetectedHardware();
  const manual = remote ? null : getManualHardware();
  hwProfile = manual || detected;
  if (hwTitleEl) hwTitleEl.textContent = remote ? t('common.remote.hardwareTitle') : t('settings.engine.hardware.title');
  if (hwDescEl) hwDescEl.textContent = remote ? t('common.remote.hardwareDescription') : t('settings.engine.hardware.description');
  if (hwToggleBtn) hwToggleBtn.hidden = remote;
  if (remote && hwFormEl) {
    hwFormEl.hidden = true;
    hwToggleBtn?.setAttribute('aria-expanded', 'false');
  }
  const unknown = t('settings.engine.hardware.notDetected');
  hwRamEl.textContent = detected.known ? formatBytes(detected.ramBytes) : unknown;
  if (!detected.known) hwGpuEl.textContent = unknown;
  else if (detected.vramBytes > 0) {
    hwGpuEl.textContent = t('common.hardware.gpuVram', {
      name: detected.gpuName || t('common.hardware.gpuGeneric'),
      vram: formatBytes(detected.vramBytes),
    });
  } else hwGpuEl.textContent = t('settings.engine.hardware.noGpuDetected');
  hwUsedEl.textContent = remote
    ? t('common.remote.hardwareNote')
    : manual
    ? t('settings.engine.hardware.usedManual', { profile: describeProfile(manual) })
    : t('settings.engine.hardware.usedAuto');
  if (hwResetBtn) hwResetBtn.hidden = !manual;
  renderModels();
}

function setupHardware() {
  buildHardwareOptions();
  hwToggleBtn?.addEventListener('click', async () => {
    if (!hwFormEl) return;
    const open = hwFormEl.hidden;
    hwFormEl.hidden = !open;
    hwToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    setHwError('');
    if (open) await fillHardwareForm();
  });
  hwGpuSelect?.addEventListener('change', () => {
    syncVramField();
    setHwError('');
  });
  hwSaveBtn?.addEventListener('click', () => {
    if (!hwRamSelect || !hwGpuSelect || !hwVramInput || !hwFormEl || !hwToggleBtn) return;
    let vramGb = 0;
    let gpuName = '';
    if (hwGpuSelect.value === HW_OTHER) {
      vramGb = Number(hwVramInput.value);
      if (!Number.isFinite(vramGb) || vramGb <= 0 || vramGb > 512) {
        setHwError(t('settings.engine.hardware.vramInvalid'));
        hwVramInput.focus();
        return;
      }
    } else if (hwGpuSelect.value !== HW_NONE) {
      const g = GPU_PRESETS[Number(hwGpuSelect.value)];
      if (g) {
        vramGb = g.vramGb;
        gpuName = g.name;
      }
    }
    setHwError('');
    setManualHardware({ ramBytes: Number(hwRamSelect.value) * GIB, vramBytes: vramGb * GIB, gpuName });
    hwFormEl.hidden = true;
    hwToggleBtn.setAttribute('aria-expanded', 'false');
  });
  hwResetBtn?.addEventListener('click', () => {
    clearManualHardware();
    if (hwFormEl) hwFormEl.hidden = true;
    hwToggleBtn?.setAttribute('aria-expanded', 'false');
  });
  onHardwareChange(loadHardware);
  loadHardware();
}

setupHardware();

// ---------- À propos : dossier des données (GET /api/system) ----------

// Bouton « Désinstaller » : app de bureau seulement (commande Tauri `uninstall_app`).
function setupUninstall() {
  const block = byId('about-uninstall');
  const btn = /** @type {HTMLButtonElement|null} */ (byId('about-uninstall-btn'));
  const status = byId('about-uninstall-status');
  if (!block || !btn || !status) return;
  block.hidden = false;
  btn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: t('settings.about.uninstall.dialogTitle'),
      message: t('settings.about.uninstall.dialogMessage'),
      confirmLabel: t('settings.about.uninstall.confirm'),
    });
    if (!ok) return;
    status.hidden = true;
    btn.disabled = true;
    try {
      await invoke('uninstall_app');
    } catch (e) {
      status.textContent = typeof e === 'string' ? e : (e && e.message) || String(e);
      status.hidden = false;
      btn.disabled = false;
    }
  });
}

async function loadSystemInfo() {
  try {
    const res = await fetch('/api/system');
    if (!res.ok) return;
    const info = await res.json();
    if (info && info.desktop === true) setupUninstall();
    if (info && typeof info.dataDir === 'string' && info.dataDir) {
      const row = byId('about-datadir-row');
      const pathEl = byId('about-datadir');
      const note = byId('about-datadir-note');
      const copyBtn = /** @type {HTMLButtonElement|null} */ (byId('about-datadir-copy'));
      if (!row || !pathEl || !note || !copyBtn) return;
      pathEl.textContent = info.dataDir;
      note.textContent = t(info.desktop ? 'settings.about.dataDirDesktop' : 'settings.about.dataDirWeb');
      row.hidden = false;
      const fallback = byId('about-data-fallback');
      if (fallback) fallback.hidden = true;
      /** @type {ReturnType<typeof setTimeout>|undefined} */
      let copyTimer;
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(info.dataDir);
        } catch {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(pathEl);
          sel?.removeAllRanges();
          sel?.addRange(range);
          return;
        }
        copyBtn.textContent = t('settings.about.copied');
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => {
          copyBtn.textContent = t('settings.about.copy');
        }, 1800);
      });
    }
  } catch {
    /* /api/system indisponible : on garde l'affichage par défaut */
  }
}

loadSystemInfo();
loadEngine();
