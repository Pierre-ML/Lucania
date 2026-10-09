// Page Paramètres : navigation par sections, apparence/langue + gestion des connexions Ollama.
import {
  listConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnectionUrl,
  testConnection,
} from './connections.js';
import { invoke } from '@tauri-apps/api/core';
import { confirmDialog } from './dialog.js';
import { t, getLang, setLang } from './i18n.js';
import { THEMES, getTheme, setTheme } from './theme.js';

/** @typedef {import('./connections.js').Connection} Connection */
/** @typedef {import('./connections.js').TestResult} TestResult */

/** @param {string} sel @param {ParentNode} [root] */
const $ = (sel, root = document) => root.querySelector(sel);
/** @param {string} id */
const byId = (id) => document.getElementById(id);

const listEl = byId('connections-list');
const emptyEl = byId('connections-empty');
const loadingEl = byId('connections-loading');
const feedbackEl = byId('connections-feedback');
const tplConn = /** @type {HTMLTemplateElement} */ (byId('tpl-connection'));
const tplChip = /** @type {HTMLTemplateElement} */ (byId('tpl-chip'));
const tplDetected = /** @type {HTMLTemplateElement} */ (byId('tpl-detected'));

const dlg = /** @type {HTMLDialogElement} */ (byId('connection-dialog'));
const form = /** @type {HTMLFormElement} */ (byId('connection-form'));
const titleEl = byId('cf-title');
const errorBanner = byId('cf-error');
const step1 = dlg.querySelector('[data-step="1"]');
const step2 = dlg.querySelector('[data-step="2"]');
const backBtn = /** @type {HTMLButtonElement} */ ($('[data-action="back"]', dlg));
const hostInput = /** @type {HTMLInputElement} */ (byId('cf-host'));
const customInput = /** @type {HTMLInputElement} */ (byId('cf-url'));
const nameBtn = /** @type {HTMLButtonElement} */ (byId('cf-name-btn'));
const nameText = byId('cf-name-text');
const nameInput = /** @type {HTMLInputElement} */ (byId('cf-name'));
const autoSwitch = /** @type {HTMLButtonElement} */ (byId('cf-auto'));
const manualInput = /** @type {HTMLInputElement} */ (byId('cf-manual-input'));
const manualList = byId('cf-manual-list');
const statusEl = byId('cf-status');
const statusDot = /** @type {HTMLElement} */ ($('[data-test-dot]', statusEl));
const statusText = /** @type {HTMLElement} */ ($('[data-test-text]', statusEl));
const statusHelp = /** @type {HTMLElement} */ ($('[data-test-help]', statusEl));
const statusHelpText = /** @type {HTMLElement} */ ($('[data-test-help-text]', statusEl));
const guideLink = /** @type {HTMLElement} */ ($('[data-guide]', statusEl));
const statusModels = /** @type {HTMLElement} */ ($('[data-test-models]', statusEl));
const retryBtn = /** @type {HTMLButtonElement} */ ($('[data-action="retry"]', statusEl));
const tplPill = /** @type {HTMLTemplateElement} */ (byId('tpl-pill'));
const detectedWrap = byId('cf-detected');
const detectedList = byId('cf-detected-list');
const sdSwitch = /** @type {HTMLButtonElement} */ (byId('cf-sd-enabled'));
const sdFields = byId('cf-sd-fields');
const sdUrl = /** @type {HTMLInputElement} */ (byId('cf-sd-url'));
const sdMethod = /** @type {HTMLSelectElement} */ (byId('cf-sd-method'));
const sdToken = /** @type {HTMLInputElement} */ (byId('cf-sd-token'));
const sdClearWrap = byId('cf-sd-clear-wrap');
const sdClear = /** @type {HTMLInputElement} */ (byId('cf-sd-clear'));
const advanced = /** @type {HTMLDetailsElement} */ (byId('cf-advanced'));
const saveBtn = /** @type {HTMLButtonElement} */ (byId('cf-save'));
const saveLabel = byId('cf-save-label');

/** @type {Connection[]} */
let connections = [];
/** @type {string|null} */
let editingId = null;
/** @type {string[]} */
let manualModels = [];
/** @type {'local'|'remote'|'custom'} */
let mode = 'local';
let nameTouched = false;
let busy = false;
let testSeq = 0;
/** @type {ReturnType<typeof setTimeout>|undefined} */
let testTimer;
/** @type {string[]} */
let detected = [];

// ---------- Navigation par sections (#connexions, #apparence, #wireguard, #a-propos) ----------

/** @type {HTMLElement[]} */
const panels = [...document.querySelectorAll('[data-panel]')];
/** @type {HTMLElement[]} */
const navLinks = [...document.querySelectorAll('[data-nav]')];
const DEFAULT_PANEL = 'connexions';

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

autoSwitch.addEventListener('click', () => setOn(autoSwitch, !isOn(autoSwitch)));

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

/** @param {Connection} conn */
function hostOf(conn) {
  try {
    return new URL(conn.baseUrl).host;
  } catch {
    return conn.baseUrl;
  }
}

/** @param {Connection} conn */
function buildItem(conn) {
  const frag = /** @type {DocumentFragment} */ (tplConn.content.cloneNode(true));
  const li = /** @type {HTMLElement} */ ($('[data-connection]', frag));
  li.dataset.id = conn.id;
  const kindLabel = t(conn.kind === 'local' ? 'settings.connections.kindLocal' : 'settings.connections.kindRemote');
  li.dataset.base = `${kindLabel} · ${hostOf(conn)}`;
  $('[data-name]', li).textContent = conn.name;

  const toggle = /** @type {HTMLButtonElement} */ ($('[data-toggle]', li));
  toggle.setAttribute('aria-label', t('settings.connections.toggleLabel', { name: conn.name }));
  const info = $('[data-info]', li);
  /** @param {boolean} on */
  const applyToggle = (on) => {
    setOn(toggle, on);
    info.classList.toggle('opacity-50', !on);
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
      if (updated.enabled) runStatus(li, conn);
      else setStatus(li, 'off', t('settings.connections.status.disabled'));
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

  $('[data-test]', li).addEventListener('click', () => {
    closeMenu({ restoreFocus: true });
    runStatus(li, conn);
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

  if (conn.enabled) runStatus(li, conn);
  else setStatus(li, 'off', t('settings.connections.status.disabled'));
  return li;
}

/** @param {number} n */
function modelsLabel(n) {
  return t('settings.connections.models', { count: n });
}

/** @param {HTMLElement} li @param {'ok'|'error'|'pending'|'off'} state @param {string} text */
function setStatus(li, state, text) {
  $('[data-status-dot]', li).dataset.state = state;
  $('[data-meta]', li).textContent = `${li.dataset.base} · ${text}`;
}

/** @param {HTMLElement} li @param {Connection} conn */
async function runStatus(li, conn) {
  setStatus(li, 'pending', t('settings.connections.status.testing'));
  try {
    const r = await testConnection(conn.id);
    if (!li.isConnected) return;
    if (r.ok) {
      const models = modelsLabel(r.models.length);
      setStatus(li, 'ok', t('settings.connections.status.ok', { ms: Math.round(r.latencyMs), models }));
    } else {
      setStatus(li, 'error', r.error || t('settings.connections.status.failed'));
    }
  } catch (e) {
    if (li.isConnected) setStatus(li, 'error', e.message);
  }
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

// ---------- Formulaire (assistant en 2 étapes) ----------

const OLLAMA_PORT = '11434';
const LOCAL_URL = `http://localhost:${OLLAMA_PORT}`;
const TEST_DEBOUNCE_MS = 600;
const MAX_PILLS = 8;

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

/**
 * Construit l'URL depuis la saisie. `addPort` : ajoute :11434 si aucun port.
 * Une URL complète http(s):// est respectée telle quelle.
 * @param {string} raw @param {boolean} addPort @returns {string|null}
 */
function buildUrl(raw, addPort) {
  const v = raw.trim();
  if (!v || /\s/.test(v)) return null;
  let candidate;
  if (/^https?:\/\//i.test(v)) candidate = v;
  else if (addPort) candidate = `http://${v}${/:\d+(\/.*)?$/.test(v) ? '' : `:${OLLAMA_PORT}`}`;
  else candidate = `http://${v}`;
  if (!isHttpUrl(candidate)) return null;
  return candidate.replace(/\/+$/, '');
}

/** @returns {string|null} */
function currentUrl() {
  if (mode === 'local') return LOCAL_URL;
  if (mode === 'remote') return buildUrl(hostInput.value, true);
  return buildUrl(customInput.value, false);
}

/** @returns {string} */
function autoName() {
  if (mode === 'local') return t('settings.form.name.local');
  const url = currentUrl();
  let host = '';
  if (url) {
    try {
      host = new URL(url).hostname;
    } catch {
      host = '';
    }
  }
  if (mode === 'remote') return host ? t('settings.form.name.remote', { host }) : t('settings.form.name.remoteFallback');
  return host || t('settings.form.name.customFallback');
}

/** @returns {string} */
function finalName() {
  return nameTouched && nameInput.value.trim() ? nameInput.value.trim() : autoName();
}

function refreshName() {
  nameText.textContent = finalName();
}

function refreshSave() {
  saveBtn.disabled = busy || !currentUrl();
}

/** @param {Element} el */
function fadeIn(el) {
  const node = /** @type {HTMLElement} */ (el);
  node.dataset.enter = '';
  node.hidden = false;
  void node.offsetWidth;
  delete node.dataset.enter;
}

function commitName() {
  const v = nameInput.value.trim();
  nameTouched = Boolean(v) && v !== autoName();
  nameInput.hidden = true;
  nameBtn.hidden = false;
  refreshName();
}

function renderManual() {
  manualList.replaceChildren();
  for (const model of manualModels) {
    const frag = /** @type {DocumentFragment} */ (tplChip.content.cloneNode(true));
    $('[data-chip-label]', frag).textContent = model;
    const btn = /** @type {HTMLButtonElement} */ ($('[data-chip-remove]', frag));
    btn.setAttribute('aria-label', t('settings.form.advanced.remove', { model }));
    btn.addEventListener('click', () => {
      manualModels = manualModels.filter((m) => m !== model);
      renderManual();
      renderDetected();
      manualInput.focus();
    });
    manualList.append(frag);
  }
}

/** @param {string} raw @returns {boolean} */
function addManual(raw) {
  const name = raw.trim();
  setFieldError('manual');
  if (!name) return false;
  if (manualModels.includes(name)) {
    setFieldError('manual', t('settings.form.advanced.manualDuplicate'));
    return false;
  }
  manualModels.push(name);
  renderManual();
  renderDetected();
  return true;
}

function renderDetected() {
  detectedList.replaceChildren();
  detectedWrap.hidden = detected.length === 0;
  for (const model of detected) {
    const frag = /** @type {DocumentFragment} */ (tplDetected.content.cloneNode(true));
    const btn = /** @type {HTMLButtonElement} */ ($('[data-detected]', frag));
    const already = manualModels.includes(model);
    btn.textContent = already ? `${model} ✓` : `+ ${model}`;
    btn.disabled = already;
    btn.setAttribute('aria-label', already ? t('settings.form.advanced.alreadyAdded', { model }) : t('settings.form.advanced.addModel', { model }));
    btn.addEventListener('click', () => addManual(model));
    detectedList.append(frag);
  }
}

// --- Bloc d'état du test ---

function hideStatus() {
  statusEl.hidden = true;
  detected = [];
  renderDetected();
}

/** @param {'ok'|'error'|'pending'} state @param {string} text @param {string[]} [models] */
function showStatus(state, text, models = []) {
  statusEl.hidden = false;
  statusDot.dataset.state = state;
  statusText.textContent = text;
  statusText.classList.toggle('text-muted', state === 'pending');
  statusText.classList.toggle('text-danger', state === 'error');

  retryBtn.hidden = state !== 'error';
  statusHelp.hidden = state !== 'error';
  if (state === 'error') {
    statusHelpText.textContent =
      mode === 'local'
        ? t('settings.form.test.helpLocal')
        : mode === 'remote'
          ? t('settings.form.test.helpRemote')
          : t('settings.form.test.helpCustom');
    guideLink.hidden = mode !== 'remote';
  }

  statusModels.replaceChildren();
  statusModels.hidden = models.length === 0;
  for (const m of models.slice(0, MAX_PILLS)) {
    const frag = /** @type {DocumentFragment} */ (tplPill.content.cloneNode(true));
    $('li', frag).textContent = m;
    statusModels.append(frag);
  }
  if (models.length > MAX_PILLS) {
    const frag = /** @type {DocumentFragment} */ (tplPill.content.cloneNode(true));
    $('li', frag).textContent = `+${models.length - MAX_PILLS}`;
    statusModels.append(frag);
  }
}

function cancelTest() {
  clearTimeout(testTimer);
  testSeq++;
}

async function runTest() {
  clearTimeout(testTimer);
  const url = currentUrl();
  const seq = ++testSeq;
  if (!url) {
    hideStatus();
    return;
  }
  showStatus('pending', mode === 'local' ? t('settings.form.test.searchingLocal') : t('settings.form.test.testing'));
  try {
    /** @type {TestResult} */
    const r = await testConnectionUrl(url);
    if (seq !== testSeq) return;
    if (r.ok) {
      showStatus('ok', t('settings.form.test.detected', { models: modelsLabel(r.models.length) }), r.models);
      detected = r.models;
    } else {
      showStatus('error', r.error || t('settings.form.test.failed'));
      detected = [];
    }
  } catch (err) {
    if (seq !== testSeq) return;
    showStatus('error', err.message || t('settings.form.test.failed'));
    detected = [];
  }
  renderDetected();
}

/** Test différé après la dernière frappe ; invalide le test précédent. */
function scheduleTest() {
  cancelTest();
  refreshName();
  refreshSave();
  hideStatus();
  if (!currentUrl()) return;
  testTimer = setTimeout(runTest, TEST_DEBOUNCE_MS);
}

// --- Étapes ---

/** @param {'local'|'remote'|'custom'} next @param {{ focus?: boolean }} [opts] */
function goStep2(next, { focus = true } = {}) {
  mode = next;
  for (const el of dlg.querySelectorAll('[data-only]')) {
    /** @type {HTMLElement} */ (el).hidden = /** @type {HTMLElement} */ (el).dataset.only !== next;
  }
  step1.hidden = true;
  fadeIn(step2);
  backBtn.hidden = Boolean(editingId);
  saveBtn.hidden = false;
  clearErrors();
  hideStatus();
  refreshName();
  refreshSave();
  if (next === 'local' || currentUrl()) runTest();
  if (focus) {
    if (next === 'local') saveBtn.focus();
    else (next === 'remote' ? hostInput : customInput).focus();
  }
}

function goStep1() {
  cancelTest();
  clearErrors();
  step2.hidden = true;
  fadeIn(step1);
  backBtn.hidden = true;
  saveBtn.hidden = true;
}

/** @param {Connection} conn @returns {{ mode: 'local'|'remote'|'custom', host: string }} */
function detectMode(conn) {
  let u;
  try {
    u = new URL(conn.baseUrl);
  } catch {
    return { mode: 'custom', host: '' };
  }
  const standard = u.protocol === 'http:' && u.port === OLLAMA_PORT && u.pathname === '/' && !u.search;
  const isLocalHost = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (standard && isLocalHost) return { mode: 'local', host: '' };
  if (standard && !isLocalHost) return { mode: 'remote', host: u.hostname };
  return { mode: 'custom', host: '' };
}

/** @param {Connection|null} conn */
function openForm(conn) {
  editingId = conn ? conn.id : null;
  busy = false;
  cancelTest();
  clearErrors();
  hideStatus();
  manualInput.value = '';
  hostInput.value = '';
  customInput.value = '';
  sdToken.value = '';
  sdClear.checked = false;
  nameInput.value = '';
  nameInput.hidden = true;
  nameBtn.hidden = false;
  nameTouched = false;
  saveLabel.textContent = conn ? t('settings.form.save') : t('settings.form.add');
  titleEl.textContent = conn ? t('settings.form.titleEdit') : t('settings.form.titleAdd');
  manualModels = conn ? [...conn.manualModels] : [];
  renderManual();

  const hasToken = Boolean(conn?.shutdown.hasToken);
  if (conn) {
    setOn(autoSwitch, conn.autoModels);
    setOn(sdSwitch, conn.shutdown.enabled);
    sdUrl.value = conn.shutdown.url || '';
    sdMethod.value = conn.shutdown.method || 'POST';
  } else {
    setOn(autoSwitch, true);
    setOn(sdSwitch, false);
    sdUrl.value = '';
    sdMethod.value = 'POST';
  }
  sdFields.hidden = !isOn(sdSwitch);
  sdToken.placeholder = hasToken ? t('settings.form.advanced.tokenSaved') : '';
  sdClearWrap.hidden = !hasToken;
  advanced.open = false;

  dlg.showModal();
  if (conn) {
    const d = detectMode(conn);
    mode = d.mode;
    if (d.mode === 'remote') hostInput.value = d.host;
    if (d.mode === 'custom') customInput.value = conn.baseUrl;
    nameInput.value = conn.name;
    nameTouched = conn.name !== autoName();
    goStep2(d.mode);
  } else {
    mode = 'local';
    goStep1();
    /** @type {HTMLElement} */ ($('[data-kind="local"]', step1)).focus();
  }
}

function closeForm() {
  if (dlg.open) dlg.close();
}

dlg.addEventListener('close', () => {
  cancelTest();
  busy = false;
});

for (const btn of document.querySelectorAll('[data-action="add-connection"]')) {
  btn.addEventListener('click', () => openForm(null));
}
for (const card of step1.querySelectorAll('[data-kind]')) {
  card.addEventListener('click', () => {
    goStep2(/** @type {'local'|'remote'|'custom'} */ (/** @type {HTMLElement} */ (card).dataset.kind));
  });
}
backBtn.addEventListener('click', () => {
  const was = mode;
  goStep1();
  /** @type {HTMLElement} */ ($(`[data-kind="${was}"]`, step1)).focus();
});
$('[data-action="cancel"]', dlg).addEventListener('click', closeForm);
retryBtn.addEventListener('click', () => {
  runTest();
});
guideLink.addEventListener('click', closeForm);

hostInput.addEventListener('input', () => {
  setFieldError('host');
  scheduleTest();
});
customInput.addEventListener('input', () => {
  setFieldError('url');
  scheduleTest();
});

// Nom : ligne discrète, éditable au clic.
nameBtn.addEventListener('click', () => {
  nameInput.value = finalName();
  nameBtn.hidden = true;
  nameInput.hidden = false;
  nameInput.focus();
  nameInput.select();
});
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitName();
    nameBtn.focus();
  }
});
nameInput.addEventListener('blur', commitName);

manualInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (addManual(manualInput.value)) manualInput.value = '';
});

sdSwitch.addEventListener('click', () => {
  setOn(sdSwitch, !isOn(sdSwitch));
  sdFields.hidden = !isOn(sdSwitch);
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy || step2.hidden) return;
  clearErrors();
  if (!nameInput.hidden) commitName();
  const baseUrl = currentUrl();
  const sdEnabled = isOn(sdSwitch);
  const sdUrlValue = sdUrl.value.trim();

  if (!baseUrl) {
    const field = mode === 'remote' ? 'host' : 'url';
    setFieldError(field, mode === 'remote' ? t('settings.form.host.invalid') : t('settings.form.url.invalid'));
    (mode === 'remote' ? hostInput : customInput).focus();
    return;
  }
  if (sdEnabled && !isHttpUrl(sdUrlValue)) {
    advanced.open = true;
    setFieldError('shutdownUrl', t('settings.form.advanced.shutdownUrlInvalid'));
    sdUrl.focus();
    return;
  }

  /** @type {{ enabled: boolean, url: string, method: string, token?: string }} */
  const shutdown = { enabled: sdEnabled, url: sdUrlValue, method: sdMethod.value };
  if (sdClear.checked) shutdown.token = '';
  else if (sdToken.value) shutdown.token = sdToken.value;

  const input = {
    name: finalName(),
    kind: mode === 'local' ? 'local' : 'remote',
    baseUrl,
    autoModels: isOn(autoSwitch),
    manualModels,
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
    refreshSave();
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
refresh();
