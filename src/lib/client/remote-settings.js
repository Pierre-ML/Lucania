// Page Paramètres, section « Accès distant » : utiliser une tour (mode distant), partager cette machine (mode serveur), guide WireGuard.
import { openUrl } from '@tauri-apps/plugin-opener';
import { confirmDialog } from './dialog.js';
import { engineAvailable } from './engine.js';
import { t } from './i18n.js';
import {
  generateServerKey,
  getRemoteConfig,
  getRemoteState,
  getServerConfig,
  getServerInterfaces,
  onRemoteState,
  onServerState,
  setRemoteConfig,
  startServer,
  testRemote,
} from './remote.js';

/**
 * @typedef {import('./remote.js').ServerConfig} ServerConfig
 * @typedef {import('./remote.js').ServerInterface} ServerInterface
 * @typedef {import('./remote.js').RemoteConfig} RemoteConfig
 * @typedef {import('./remote.js').RemoteState} RemoteState
 * @typedef {import('./remote.js').RemoteTestResult} RemoteTestResult
 */

const ALL_INTERFACES = '0.0.0.0';
const LOOPBACK = '127.0.0.1';
const DEFAULT_PORT = 4750;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

/** @param {string} id */
const byId = (id) => document.getElementById(id);

/** @param {unknown} e */
function messageOf(e) {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return t('settings.server.errors.generic');
}

/** @param {HTMLElement|null} target @param {string} msg */
function setText(target, msg) {
  if (!target) return;
  target.textContent = msg;
  target.hidden = !msg;
}

/** @param {number} bytes */
function formatGb(bytes) {
  const gb = bytes / 1024 ** 3;
  const text = new Intl.NumberFormat(document.documentElement.lang || undefined, { maximumFractionDigits: 1 }).format(gb);
  return t('settings.remote.client.result.vramGb', { vram: text });
}

export function initRemoteSettings() {
  const mainEl = byId('remote-main');
  const unavailableEl = byId('remote-unavailable');
  const loadingEl = byId('remote-loading');
  if (!mainEl || !unavailableEl) return;

  if (!engineAvailable()) {
    if (loadingEl) loadingEl.hidden = true;
    unavailableEl.textContent = t('chat.engine.unavailable');
    unavailableEl.hidden = false;
    return;
  }

  // Bloc client
  const form = byId('remote-form');
  const modeInputs = /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll('[data-remote-mode]')]);
  const fieldsEl = byId('remote-fields');
  const urlInput = /** @type {HTMLInputElement|null} */ (byId('remote-url'));
  const keyInput = /** @type {HTMLInputElement|null} */ (byId('remote-key'));
  const testBtn = /** @type {HTMLButtonElement|null} */ (byId('remote-test'));
  const testResult = byId('remote-test-result');
  const testError = byId('remote-test-error');
  const stateEl = byId('remote-state');
  const saveBtn = /** @type {HTMLButtonElement|null} */ (byId('remote-save'));
  const noteEl = byId('remote-note');
  const errorEl = byId('remote-error');

  // Bloc serveur
  const ifaceSelect = /** @type {HTMLSelectElement|null} */ (byId('server-interface'));
  const allBlock = byId('server-all-block');
  const allowAllInput = /** @type {HTMLInputElement|null} */ (byId('server-allow-all'));
  const portInput = /** @type {HTMLInputElement|null} */ (byId('server-port'));
  const keyStatusEl = byId('server-key-status');
  const keyGenBtn = /** @type {HTMLButtonElement|null} */ (byId('server-key-generate'));
  const keyRevealEl = byId('server-key-reveal');
  const keyValueInput = /** @type {HTMLInputElement|null} */ (byId('server-key-value'));
  const keyCopyBtn = /** @type {HTMLButtonElement|null} */ (byId('server-key-copy'));
  const startBtn = /** @type {HTMLButtonElement|null} */ (byId('server-start'));
  const hintEl = byId('server-hint');
  const runningEl = byId('server-running');
  const serverErrorEl = byId('server-error');

  /** @type {RemoteConfig|null} */
  let remoteConfig = null;
  /** @type {RemoteState|null} */
  let remoteState = null;
  /** @type {ServerConfig|null} */
  let serverConfig = null;
  let starting = false;
  let generating = false;
  let saving = false;

  // ---- Bloc client ----

  function currentMode() {
    return modeInputs.find((r) => r.checked)?.value === 'remote' ? 'remote' : 'local';
  }

  function renderMode() {
    if (fieldsEl) fieldsEl.hidden = currentMode() !== 'remote';
    renderState();
  }

  function renderState() {
    if (!stateEl) return;
    const mode = remoteState?.mode ?? remoteConfig?.mode ?? 'local';
    stateEl.dataset.bad = 'false';
    if (mode === 'local') {
      stateEl.textContent = t('settings.remote.client.state.local');
      return;
    }
    if (!remoteState) {
      stateEl.textContent = '';
      return;
    }
    if (remoteState.connected) {
      stateEl.textContent = t('settings.remote.client.state.connected');
    } else {
      stateEl.dataset.bad = 'true';
      stateEl.textContent = remoteState.error
        ? t('settings.remote.client.state.unreachable', { error: remoteState.error })
        : t('settings.remote.client.state.unreachableNoError');
    }
  }

  /** @param {RemoteConfig} cfg */
  function renderRemoteConfig(cfg) {
    remoteConfig = cfg;
    for (const r of modeInputs) r.checked = r.value === cfg.mode;
    if (urlInput && document.activeElement !== urlInput) urlInput.value = cfg.url || '';
    if (keyInput) {
      keyInput.placeholder = cfg.hasKey ? t('settings.remote.client.key.savedPlaceholder') : t('settings.remote.client.key.placeholder');
    }
    renderMode();
  }

  /** @param {RemoteTestResult} r */
  function renderTestResult(r) {
    const set = (/** @type {string} */ name, /** @type {string} */ value) => {
      const target = testResult?.querySelector(`[data-remote-res="${name}"]`);
      if (target) target.textContent = value;
    };
    set('latency', t('settings.remote.client.result.latencyMs', { ms: Math.round(r.latencyMs) }));
    set('version', r.version || '—');
    set('backend', r.backend === 'cuda' ? t('settings.remote.client.result.backendCuda') : t('settings.remote.client.result.backendCpu'));
    const gpu = r.gpuName
      ? r.vramBytes != null
        ? t('settings.remote.client.result.gpuVram', { name: r.gpuName, vram: formatGb(r.vramBytes) })
        : r.gpuName
      : t('settings.remote.client.result.noGpu');
    set('gpu', gpu);
    set('model', r.loadedModel || t('settings.remote.client.result.noModel'));
    if (testResult) testResult.hidden = false;
  }

  for (const r of modeInputs) r.addEventListener('change', renderMode);

  testBtn?.addEventListener('click', async () => {
    if (!urlInput || !testBtn) return;
    setText(testError, '');
    if (testResult) testResult.hidden = true;
    const url = urlInput.value.trim();
    if (!url) {
      setText(testError, t('settings.remote.client.urlRequired'));
      urlInput.focus();
      return;
    }
    const label = testBtn.textContent;
    testBtn.disabled = true;
    testBtn.textContent = t('settings.remote.client.testing');
    try {
      const key = keyInput?.value.trim() || null;
      renderTestResult(await testRemote({ url, key }));
    } catch (e) {
      setText(testError, messageOf(e));
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = label;
    }
  });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving || !saveBtn || !urlInput) return;
    setText(errorEl, '');
    setText(noteEl, '');
    const mode = currentMode();
    const url = urlInput.value.trim();
    if (mode === 'remote' && !url) {
      setText(errorEl, t('settings.remote.client.urlRequired'));
      urlInput.focus();
      return;
    }
    const changed = mode !== (remoteConfig?.mode ?? 'local');
    saving = true;
    saveBtn.disabled = true;
    const label = saveBtn.textContent;
    saveBtn.textContent = t('settings.remote.client.saving');
    try {
      const key = keyInput?.value.trim() || null;
      const cfg = await setRemoteConfig({ mode, url, key });
      if (keyInput) keyInput.value = '';
      renderRemoteConfig(cfg);
      if (changed) {
        // Les caches de la page (modèles, état, matériel) doivent repartir de zéro.
        setText(noteEl, t('settings.remote.client.reloading'));
        location.reload();
        return;
      }
      setText(noteEl, t('settings.remote.client.saved'));
      refreshRemoteState();
    } catch (err) {
      setText(errorEl, messageOf(err));
    } finally {
      saving = false;
      saveBtn.disabled = false;
      saveBtn.textContent = label;
    }
  });

  async function refreshRemoteState() {
    try {
      remoteState = await getRemoteState();
      renderState();
    } catch {
      // État indisponible : on garde l'affichage actuel.
    }
  }

  // ---- Bloc serveur ----

  /** @param {ServerConfig} cfg */
  function renderServerConfig(cfg) {
    serverConfig = cfg;
    if (keyStatusEl) keyStatusEl.textContent = cfg.hasKey ? t('settings.server.key.set') : t('settings.server.key.none');
    if (cfg.running) {
      setText(runningEl, t('settings.server.running', { address: cfg.address ?? '' }));
    } else {
      setText(runningEl, '');
    }
    if (cfg.error) setText(serverErrorEl, cfg.error);
    renderStartState();
  }

  function isAllSelected() {
    return ifaceSelect?.value === ALL_INTERFACES;
  }

  /** @returns {number|null} port valide ou null */
  function readPort() {
    const n = Number(portInput?.value);
    return Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT ? n : null;
  }

  function renderStartState() {
    const all = isAllSelected();
    if (allBlock) allBlock.hidden = !all;
    if (portInput) portInput.setAttribute('aria-invalid', readPort() === null ? 'true' : 'false');
    let hint = '';
    if (!serverConfig?.hasKey) hint = t('settings.server.hint.needKey');
    else if (all && !allowAllInput?.checked) hint = t('settings.server.hint.needAck');
    else if (readPort() === null) hint = t('settings.server.port.invalid');
    if (hintEl) hintEl.textContent = hint;
    if (startBtn) startBtn.disabled = starting || !!hint;
  }

  /** @param {ServerInterface[]} ifaces @param {ServerConfig} cfg */
  function renderInterfaces(ifaces, cfg) {
    if (!ifaceSelect) return;
    ifaceSelect.replaceChildren();
    for (const i of ifaces) {
      const opt = document.createElement('option');
      opt.value = i.ip;
      opt.textContent = i.wireguard
        ? t('settings.server.interface.optionWireguard', { name: i.name, ip: i.ip })
        : t('settings.server.interface.option', { name: i.name, ip: i.ip });
      ifaceSelect.append(opt);
    }
    const all = document.createElement('option');
    all.value = ALL_INTERFACES;
    all.textContent = t('settings.server.interface.all');
    ifaceSelect.append(all);

    const has = (/** @type {string} */ ip) => [...ifaceSelect.options].some((o) => o.value === ip);
    const wg = ifaces.find((i) => i.wireguard);
    // Valeur enregistrée d'abord (choix explicite de l'utilisateur), puis WireGuard, puis la boucle locale.
    const saved = cfg.bindIp && (cfg.bindIp !== ALL_INTERFACES || cfg.allowAll) && has(cfg.bindIp) ? cfg.bindIp : null;
    const pick = saved ?? wg?.ip ?? (has(LOOPBACK) ? LOOPBACK : ifaces[0]?.ip ?? ALL_INTERFACES);
    ifaceSelect.value = pick;
    if (allowAllInput) allowAllInput.checked = pick === ALL_INTERFACES && cfg.allowAll;
  }

  ifaceSelect?.addEventListener('change', () => {
    if (allowAllInput && !isAllSelected()) allowAllInput.checked = false;
    renderStartState();
  });
  allowAllInput?.addEventListener('change', renderStartState);
  portInput?.addEventListener('input', renderStartState);

  keyGenBtn?.addEventListener('click', async () => {
    if (generating || !keyGenBtn) return;
    setText(serverErrorEl, '');
    if (serverConfig?.hasKey) {
      const ok = await confirmDialog({
        title: t('settings.server.key.confirm.title'),
        message: t('settings.server.key.confirm.message'),
        confirmLabel: t('settings.server.key.confirm.ok'),
        danger: false,
      });
      if (!ok) return;
    }
    generating = true;
    keyGenBtn.disabled = true;
    try {
      const key = await generateServerKey();
      if (keyValueInput) keyValueInput.value = key;
      if (keyRevealEl) keyRevealEl.hidden = false;
      if (keyCopyBtn) keyCopyBtn.textContent = t('settings.server.key.copy');
      renderServerConfig({ ...(serverConfig ?? defaultServerConfig()), hasKey: true });
    } catch (e) {
      setText(serverErrorEl, messageOf(e));
    } finally {
      generating = false;
      keyGenBtn.disabled = false;
    }
  });

  keyCopyBtn?.addEventListener('click', async () => {
    if (!keyValueInput || !keyCopyBtn) return;
    keyValueInput.select();
    try {
      await navigator.clipboard.writeText(keyValueInput.value);
      keyCopyBtn.textContent = t('settings.server.key.copied');
      setTimeout(() => {
        keyCopyBtn.textContent = t('settings.server.key.copy');
      }, 2000);
    } catch {
      // Presse-papiers refusé : la clé reste sélectionnée pour un copier manuel.
    }
  });

  startBtn?.addEventListener('click', async () => {
    if (starting || !startBtn || !ifaceSelect) return;
    const port = readPort();
    if (port === null) {
      renderStartState();
      portInput?.focus();
      return;
    }
    setText(serverErrorEl, '');
    starting = true;
    const label = startBtn.textContent;
    startBtn.disabled = true;
    startBtn.textContent = t('settings.server.starting');
    try {
      const all = isAllSelected();
      const cfg = await startServer({ bindIp: ifaceSelect.value, port, allowAll: all && !!allowAllInput?.checked });
      if (cfg.running) {
        location.replace('/serveur');
        return;
      }
      renderServerConfig(cfg);
      if (!cfg.error) setText(serverErrorEl, t('settings.server.errors.generic'));
    } catch (e) {
      setText(serverErrorEl, messageOf(e));
    }
    starting = false;
    startBtn.textContent = label;
    renderStartState();
  });

  /** @returns {ServerConfig} */
  function defaultServerConfig() {
    return { bindIp: null, port: DEFAULT_PORT, allowAll: false, hasKey: false, active: false, running: false, address: null, error: null };
  }

  // ---- Guide ----

  for (const link of document.querySelectorAll('[data-remote-link]')) {
    link.addEventListener('click', async () => {
      const url = link.getAttribute('data-remote-link');
      if (!url) return;
      try {
        await openUrl(url);
      } catch (e) {
        setText(errorEl, messageOf(e));
      }
    });
  }

  // ---- Chargement ----

  async function load() {
    try {
      const [rc, sc, ifaces] = await Promise.all([getRemoteConfig(), getServerConfig(), getServerInterfaces()]);
      renderRemoteConfig(rc);
      if (portInput) portInput.value = String(sc.port || DEFAULT_PORT);
      renderInterfaces(ifaces, sc);
      renderServerConfig(sc);
      mainEl.hidden = false;
      refreshRemoteState();
    } catch (e) {
      unavailableEl.textContent = messageOf(e);
      unavailableEl.hidden = false;
    } finally {
      if (loadingEl) loadingEl.hidden = true;
    }
  }

  onRemoteState((s) => {
    remoteState = s;
    renderState();
  }).catch(() => {});
  onServerState((cfg) => {
    if (!starting) renderServerConfig(cfg);
  }).catch(() => {});

  load();
}
