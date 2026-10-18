// Page Paramètres : navigation par sections, moteur local, apparence/langue + gestion des connexions (extinction à distance).
import {
  listConnections,
  createConnection,
  updateConnection,
  deleteConnection,
} from './connections.js';
import {
  engineAvailable,
  getEngineInfo,
  getEngineStatus,
  listModels,
  onEngineStatus,
  useModel,
  unloadModel,
  deleteModel,
} from './engine.js';
import { errorMessage, onDownload } from './hf.js';
import { invoke } from '@tauri-apps/api/core';
import { confirmDialog } from './dialog.js';
import { t, getLang, setLang } from './i18n.js';
import { THEMES, getTheme, setTheme } from './theme.js';

/** @typedef {import('./connections.js').Connection} Connection */

/** @param {string} sel @param {ParentNode} [root] */
const $ = (sel, root = document) => root.querySelector(sel);
/** @param {string} id */
const byId = (id) => document.getElementById(id);

const listEl = byId('connections-list');
const emptyEl = byId('connections-empty');
const loadingEl = byId('connections-loading');
const feedbackEl = byId('connections-feedback');
const tplConn = /** @type {HTMLTemplateElement} */ (byId('tpl-connection'));

const dlg = /** @type {HTMLDialogElement} */ (byId('connection-dialog'));
const form = /** @type {HTMLFormElement} */ (byId('connection-form'));
const titleEl = byId('cf-title');
const errorBanner = byId('cf-error');
const nameInput = /** @type {HTMLInputElement} */ (byId('cf-name'));
const kindSelect = /** @type {HTMLSelectElement} */ (byId('cf-kind'));
const sdSwitch = /** @type {HTMLButtonElement} */ (byId('cf-sd-enabled'));
const sdFields = byId('cf-sd-fields');
const sdUrl = /** @type {HTMLInputElement} */ (byId('cf-sd-url'));
const sdMethod = /** @type {HTMLSelectElement} */ (byId('cf-sd-method'));
const sdToken = /** @type {HTMLInputElement} */ (byId('cf-sd-token'));
const sdClearWrap = byId('cf-sd-clear-wrap');
const sdClear = /** @type {HTMLInputElement} */ (byId('cf-sd-clear'));
const saveBtn = /** @type {HTMLButtonElement} */ (byId('cf-save'));
const saveLabel = byId('cf-save-label');

/** @type {Connection[]} */
let connections = [];
/** @type {string|null} */
let editingId = null;
let busy = false;

// ---------- Navigation par sections (#moteur, #connexions, #apparence, #a-propos…) ----------

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

// ---------- Interrupteurs (helpers) ----------

/** @param {Element} sw */
const isOn = (sw) => sw.getAttribute('aria-checked') === 'true';
/** @param {Element} sw @param {boolean} on */
const setOn = (sw, on) => sw.setAttribute('aria-checked', on ? 'true' : 'false');

// ---------- Menu « ⋯ » (un seul ouvert à la fois) ----------

/** @type {HTMLElement|null} */
let openWrap = null;

function closeMenu({ restoreFocus = false } = {}) {
  if (!openWrap) return;
  const wrap = openWrap;
  openWrap = null;
  /** @type {HTMLElement} */ ($('[data-menu]', wrap)).hidden = true;
  const btn = /** @type {HTMLElement} */ ($('[data-menu-button]', wrap));
  btn.setAttribute('aria-expanded', 'false');
  if (restoreFocus) btn.focus();
}

/** @param {HTMLElement} wrap */
function openMenu(wrap) {
  closeMenu();
  const menu = /** @type {HTMLElement} */ ($('[data-menu]', wrap));
  menu.hidden = false;
  menu.removeAttribute('data-flip');
  if (menu.getBoundingClientRect().bottom > window.innerHeight - 8) menu.setAttribute('data-flip', '');
  $('[data-menu-button]', wrap).setAttribute('aria-expanded', 'true');
  openWrap = wrap;
}

document.addEventListener('click', (e) => {
  if (openWrap && !openWrap.contains(/** @type {Node} */ (e.target))) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (!openWrap) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeMenu({ restoreFocus: true });
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = /** @type {HTMLElement[]} */ ([...openWrap.querySelectorAll('[role="menuitem"]')]);
    const i = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : i <= 0 ? items.length - 1 : i - 1;
    items[next].focus();
  }
});

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

/** Taille lisible (Mo / Go) selon la langue courante. @param {number} bytes */
function formatSize(bytes) {
  const nf = (/** @type {number} */ n) =>
    new Intl.NumberFormat(getLang(), { maximumFractionDigits: n >= 100 ? 0 : 1 }).format(n);
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${nf(gb)} ${t('settings.engine.unitGb')}`;
  return `${nf(bytes / 1024 ** 2)} ${t('settings.engine.unitMb')}`;
}

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
  li.dataset.modelId = model.id;
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
  const meta = document.createElement('p');
  meta.className = 'mt-0.5 truncate font-mono text-[11px] text-muted';
  meta.textContent = `${formatSize(model.sizeBytes)} · ${model.id}`;
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
  } catch (e) {
    showEngineError(errorMessage(e));
  } finally {
    engineLoadingEl.hidden = true;
    if (engineRefreshBtn) engineRefreshBtn.disabled = false;
  }
}

engineRefreshBtn?.addEventListener('click', loadEngine);

// ---------- Liste des connexions ----------

/** @param {string} msg */
function showFeedback(msg) {
  if (!feedbackEl) return;
  feedbackEl.textContent = msg;
  feedbackEl.classList.toggle('hidden', !msg);
}

function renderList() {
  if (!listEl) return;
  closeMenu();
  listEl.replaceChildren();
  if (loadingEl) loadingEl.hidden = true;
  listEl.setAttribute('aria-busy', 'false');
  listEl.hidden = connections.length === 0;
  if (emptyEl) emptyEl.hidden = connections.length > 0;
  for (const conn of connections) listEl.append(buildItem(conn));
}

/** Ligne de détail : type · état de l'extinction (ou « Désactivée »). @param {Connection} conn */
function metaText(conn) {
  const kind = t(conn.kind === 'local' ? 'settings.connections.kindLocal' : 'settings.connections.kindRemote');
  const state = !conn.enabled
    ? t('settings.connections.status.disabled')
    : t(conn.shutdown.enabled ? 'settings.connections.shutdownOn' : 'settings.connections.shutdownOff');
  return `${kind} · ${state}`;
}

/** @param {Connection} conn */
function buildItem(conn) {
  const frag = /** @type {DocumentFragment} */ (tplConn.content.cloneNode(true));
  const li = /** @type {HTMLElement} */ ($('[data-connection]', frag));
  li.dataset.id = conn.id;
  $('[data-name]', li).textContent = conn.name;
  const meta = $('[data-meta]', li);

  const toggle = /** @type {HTMLButtonElement} */ ($('[data-toggle]', li));
  toggle.setAttribute('aria-label', t('settings.connections.toggleLabel', { name: conn.name }));
  const info = $('[data-info]', li);
  /** @param {boolean} on */
  const applyToggle = (on) => {
    setOn(toggle, on);
    info.classList.toggle('opacity-50', !on);
    meta.textContent = metaText(conn);
  };
  applyToggle(conn.enabled);

  toggle.addEventListener('click', async () => {
    const next = !isOn(toggle);
    toggle.disabled = true;
    showFeedback('');
    try {
      const updated = await updateConnection(conn.id, { enabled: next });
      Object.assign(conn, updated);
      applyToggle(updated.enabled);
    } catch (e) {
      showFeedback(e.message);
    } finally {
      toggle.disabled = false;
    }
  });

  const wrap = /** @type {HTMLElement} */ ($('[data-menu-wrap]', li));
  $('[data-menu-button]', li).addEventListener('click', () => {
    if (openWrap === wrap) {
      closeMenu();
      return;
    }
    openMenu(wrap);
    /** @type {HTMLElement} */ ($('[role="menuitem"]', wrap)).focus();
  });
  wrap.addEventListener('focusout', (e) => {
    const next = /** @type {Node|null} */ (e.relatedTarget);
    if (openWrap === wrap && next && !wrap.contains(next)) closeMenu();
  });

  $('[data-edit]', li).addEventListener('click', () => {
    closeMenu();
    openForm(conn);
  });
  $('[data-delete]', li).addEventListener('click', async () => {
    closeMenu();
    const ok = await confirmDialog({
      title: t('settings.connections.delete.title'),
      message: t('settings.connections.delete.message', { name: conn.name }),
    });
    if (!ok) return;
    try {
      await deleteConnection(conn.id);
      await refresh();
    } catch (e) {
      showFeedback(e.message);
    }
  });

  // Clic sur la rangée = Modifier (sauf interrupteur et menu).
  li.addEventListener('click', (e) => {
    if (/** @type {HTMLElement} */ (e.target).closest('[data-stop]')) return;
    openForm(conn);
  });

  return li;
}

async function refresh() {
  try {
    connections = await listConnections();
    showFeedback('');
  } catch (e) {
    showFeedback(e.message);
  }
  renderList();
  renderShutdown();
}

// ---------- Formulaire (nom, type, extinction à distance) ----------

/** @param {string} field @param {string} [msg] */
function setFieldError(field, msg = '') {
  const el = $(`[data-error-for="${field}"]`, dlg);
  if (!el) return;
  el.textContent = msg;
  /** @type {HTMLElement} */ (el).hidden = !msg;
  const input = $(`[data-field="${field}"]`, dlg);
  if (input) {
    if (msg) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

function clearErrors() {
  for (const el of dlg.querySelectorAll('[data-error-for]')) {
    el.textContent = '';
    /** @type {HTMLElement} */ (el).hidden = true;
  }
  for (const el of dlg.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
  errorBanner.textContent = '';
  errorBanner.hidden = true;
}

/** @param {string} value */
function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && Boolean(u.hostname);
  } catch {
    return false;
  }
}

/** @param {Connection|null} conn */
function openForm(conn) {
  editingId = conn ? conn.id : null;
  busy = false;
  clearErrors();
  sdToken.value = '';
  sdClear.checked = false;
  nameInput.value = conn ? conn.name : '';
  kindSelect.value = conn ? conn.kind : 'local';
  saveLabel.textContent = conn ? t('settings.form.save') : t('settings.form.add');
  titleEl.textContent = conn ? t('settings.form.titleEdit') : t('settings.form.titleAdd');

  const hasToken = Boolean(conn?.shutdown.hasToken);
  if (conn) {
    setOn(sdSwitch, conn.shutdown.enabled);
    sdUrl.value = conn.shutdown.url || '';
    sdMethod.value = conn.shutdown.method || 'POST';
  } else {
    setOn(sdSwitch, false);
    sdUrl.value = '';
    sdMethod.value = 'POST';
  }
  sdFields.hidden = !isOn(sdSwitch);
  sdToken.placeholder = hasToken ? t('settings.form.shutdown.tokenSaved') : '';
  sdClearWrap.hidden = !hasToken;
  saveBtn.disabled = false;

  dlg.showModal();
  nameInput.focus();
}

function closeForm() {
  if (dlg.open) dlg.close();
}

dlg.addEventListener('close', () => {
  busy = false;
});

for (const btn of document.querySelectorAll('[data-action="add-connection"]')) {
  btn.addEventListener('click', () => openForm(null));
}
$('[data-action="cancel"]', dlg).addEventListener('click', closeForm);

nameInput.addEventListener('input', () => setFieldError('name'));
sdUrl.addEventListener('input', () => setFieldError('shutdownUrl'));
sdSwitch.addEventListener('click', () => {
  setOn(sdSwitch, !isOn(sdSwitch));
  sdFields.hidden = !isOn(sdSwitch);
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  clearErrors();
  const name = nameInput.value.trim();
  const sdEnabled = isOn(sdSwitch);
  const sdUrlValue = sdUrl.value.trim();

  if (!name) {
    setFieldError('name', t('settings.form.name.required'));
    nameInput.focus();
    return;
  }
  if (sdEnabled && !isHttpUrl(sdUrlValue)) {
    setFieldError('shutdownUrl', t('settings.form.shutdown.urlInvalid'));
    sdUrl.focus();
    return;
  }

  /** @type {{ enabled: boolean, url: string, method: string, token?: string }} */
  const shutdown = { enabled: sdEnabled, url: sdUrlValue, method: sdMethod.value };
  if (sdClear.checked) shutdown.token = '';
  else if (sdToken.value) shutdown.token = sdToken.value;

  const input = {
    name,
    kind: kindSelect.value === 'remote' ? 'remote' : 'local',
    shutdown,
  };

  busy = true;
  saveBtn.disabled = true;
  saveLabel.textContent = editingId ? t('settings.form.saving') : t('settings.form.adding');
  try {
    if (editingId) await updateConnection(editingId, input);
    else await createConnection(input);
    closeForm();
    await refresh();
  } catch (err) {
    errorBanner.textContent = err.message;
    errorBanner.hidden = false;
  } finally {
    busy = false;
    saveLabel.textContent = editingId ? t('settings.form.save') : t('settings.form.add');
    saveBtn.disabled = false;
  }
});

// ---------- Extinction à distance (une carte par connexion) ----------

const sdListEl = byId('shutdown-list');
const sdEmptyEl = byId('shutdown-empty');
const sdLoadingEl = byId('shutdown-loading');
const tplShutdown = /** @type {HTMLTemplateElement} */ (byId('tpl-shutdown'));
const SAVED_MS = 2500;

function renderShutdown() {
  if (!sdListEl) return;
  sdListEl.replaceChildren();
  if (sdLoadingEl) sdLoadingEl.hidden = true;
  sdListEl.hidden = connections.length === 0;
  if (sdEmptyEl) sdEmptyEl.hidden = connections.length > 0;
  for (const conn of connections) sdListEl.append(buildShutdownCard(conn));
}

/** @param {Connection} conn */
function buildShutdownCard(conn) {
  const frag = /** @type {DocumentFragment} */ (tplShutdown.content.cloneNode(true));
  const card = /** @type {HTMLElement} */ ($('[data-sd-card]', frag));
  const nameEl = $('[data-sd-name]', card);
  const sw = /** @type {HTMLButtonElement} */ ($('[data-sd-switch]', card));
  const fields = /** @type {HTMLElement} */ ($('[data-sd-fields]', card));
  const urlInput = /** @type {HTMLInputElement} */ ($('[data-sd-url]', card));
  const methodGroup = /** @type {HTMLElement} */ ($('[data-sd-method]', card));
  const methodBtns = /** @type {HTMLButtonElement[]} */ ([...methodGroup.querySelectorAll('[data-method]')]);
  const tokenInput = /** @type {HTMLInputElement} */ ($('[data-sd-token]', card));
  const clearBtn = /** @type {HTMLButtonElement} */ ($('[data-sd-clear]', card));
  const clearNote = /** @type {HTMLElement} */ ($('[data-sd-clear-note]', card));
  const saveBtn2 = /** @type {HTMLButtonElement} */ ($('[data-sd-save]', card));
  const savedEl = /** @type {HTMLElement} */ ($('[data-sd-saved]', card));
  const urlErr = /** @type {HTMLElement} */ ($('[data-sd-error="url"]', card));
  const formErr = /** @type {HTMLElement} */ ($('[data-sd-error="form"]', card));

  // Libellés accessibles (ids uniques par carte).
  const uid = `sd-${conn.id}`;
  urlInput.id = `${uid}-url`;
  tokenInput.id = `${uid}-token`;
  urlErr.id = `${uid}-url-error`;
  const methodLabel = $('[data-sd-method-label]', card);
  methodLabel.id = `${uid}-method-label`;
  /** @type {HTMLLabelElement} */ ($('[data-sd-url-label]', card)).htmlFor = urlInput.id;
  /** @type {HTMLLabelElement} */ ($('[data-sd-token-label]', card)).htmlFor = tokenInput.id;
  methodGroup.setAttribute('aria-labelledby', methodLabel.id);
  sw.setAttribute('aria-label', t('settings.shutdown.toggleLabel', { name: conn.name }));
  urlInput.setAttribute('aria-describedby', urlErr.id);

  nameEl.textContent = conn.name;

  /** État courant côté serveur (mis à jour après chaque enregistrement). */
  let cur = conn.shutdown || { enabled: false, url: '', method: 'POST', hasToken: false };
  let clearToken = false;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let savedTimer;

  /** @param {string} m */
  const setMethod = (m) => {
    for (const b of methodBtns) b.setAttribute('aria-checked', b.dataset.method === m ? 'true' : 'false');
  };
  const getMethod = () => methodBtns.find((b) => isOn(b))?.dataset.method || 'POST';
  const showFields = () => {
    fields.hidden = !isOn(sw);
  };
  const syncToken = () => {
    tokenInput.value = '';
    clearToken = false;
    tokenInput.placeholder = cur.hasToken ? t('settings.shutdown.tokenSaved') : '';
    clearBtn.hidden = !cur.hasToken;
    clearNote.hidden = true;
  };
  /** @param {string} msg */
  const setUrlError = (msg) => {
    urlErr.textContent = msg;
    urlErr.hidden = !msg;
    if (msg) urlInput.setAttribute('aria-invalid', 'true');
    else urlInput.removeAttribute('aria-invalid');
  };
  /** @param {string} msg */
  const setFormError = (msg) => {
    formErr.textContent = msg;
    formErr.hidden = !msg;
  };

  setOn(sw, Boolean(cur.enabled));
  urlInput.value = cur.url || '';
  setMethod(cur.method || 'POST');
  syncToken();
  showFields();

  sw.addEventListener('click', () => {
    setOn(sw, !isOn(sw));
    showFields();
  });
  for (const b of methodBtns) b.addEventListener('click', () => setMethod(/** @type {string} */ (b.dataset.method)));
  urlInput.addEventListener('input', () => setUrlError(''));
  clearBtn.addEventListener('click', () => {
    clearToken = true;
    tokenInput.value = '';
    clearBtn.hidden = true;
    clearNote.hidden = false;
  });
  tokenInput.addEventListener('input', () => {
    if (!tokenInput.value) return;
    clearToken = false;
    clearNote.hidden = true;
    clearBtn.hidden = !cur.hasToken;
  });

  saveBtn2.addEventListener('click', async () => {
    setUrlError('');
    setFormError('');
    clearTimeout(savedTimer);
    savedEl.hidden = true;
    const enabled = isOn(sw);
    const url = urlInput.value.trim();
    const method = getMethod();
    if (enabled && !isHttpUrl(url)) {
      setUrlError(t('settings.shutdown.urlInvalid'));
      urlInput.focus();
      return;
    }
    /** @type {{ enabled?: boolean, url?: string, method?: string, token?: string }} */
    const patch = {};
    if (enabled !== Boolean(cur.enabled)) patch.enabled = enabled;
    if (url !== (cur.url || '')) patch.url = url;
    if (method !== (cur.method || 'POST')) patch.method = method;
    if (clearToken) patch.token = '';
    else if (tokenInput.value) patch.token = tokenInput.value;

    const label = saveBtn2.textContent;
    saveBtn2.disabled = true;
    saveBtn2.textContent = t('settings.shutdown.saving');
    try {
      if (Object.keys(patch).length) {
        await updateConnection(conn.id, { shutdown: patch });
        // Garde les deux écrans cohérents : liste de connexions à jour, cartes conservées.
        try {
          connections = await listConnections();
          renderList();
          const fresh = connections.find((c) => c.id === conn.id);
          if (fresh) cur = fresh.shutdown;
        } catch {
          /* la liste sera rafraîchie au prochain chargement */
        }
        urlInput.value = cur.url || url;
        syncToken();
      }
      savedEl.hidden = false;
      savedTimer = setTimeout(() => {
        savedEl.hidden = true;
      }, SAVED_MS);
    } catch (err) {
      setFormError(err.message || '');
    } finally {
      saveBtn2.disabled = false;
      saveBtn2.textContent = label;
    }
  });

  return card;
}

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
refresh();
