// Page Paramètres, section « Accès distant » : la tour (mode serveur) et l'utilisation d'une tour depuis cette machine, guide WireGuard.
import { openUrl } from '@tauri-apps/plugin-opener';
import { confirmDialog } from './dialog.js';
import { engineAvailable } from './engine.js';
import { t } from './i18n.js';
import {
  discoverRemote,
  generateServerKey,
  getRemoteConfig,
  getRemoteState,
  getServerConfig,
  getServerInterfaces,
  getServerKey,
  onRemoteState,
  onServerState,
  setRemoteConfig,
  startServer,
  testRemote,
} from './remote.js';
import { initServerKeyField } from './server-key.js';

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

  // Carte client
  const activeEl = byId('remote-active');
  const stateEl = byId('remote-state');
  const currentUrlEl = byId('remote-current-url');
  const backLocalBtn = /** @type {HTMLButtonElement|null} */ (byId('remote-back-local'));
  const form = byId('remote-form');
  const keyInput = /** @type {HTMLInputElement|null} */ (byId('remote-key'));
  const networkSelect = /** @type {HTMLSelectElement|null} */ (byId('remote-network'));
  const connectBtn = /** @type {HTMLButtonElement|null} */ (byId('remote-connect'));
  const statusEl = byId('remote-status');
  const errorEl = byId('remote-error');
  const urlInput = /** @type {HTMLInputElement|null} */ (byId('remote-url'));
  const testBtn = /** @type {HTMLButtonElement|null} */ (byId('remote-test'));
  const manualBtn = /** @type {HTMLButtonElement|null} */ (byId('remote-connect-manual'));
  const testResult = byId('remote-test-result');
  const testError = byId('remote-test-error');

  // Carte serveur
  const startSwitch = /** @type {HTMLButtonElement|null} */ (byId('server-start'));
  const hintEl = byId('server-hint');
  const runningEl = byId('server-running');
  const serverErrorEl = byId('server-error');
  const ifaceSelect = /** @type {HTMLSelectElement|null} */ (byId('server-interface'));
  const allBlock = byId('server-all-block');
  const allowAllInput = /** @type {HTMLInputElement|null} */ (byId('server-allow-all'));
  const portInput = /** @type {HTMLInputElement|null} */ (byId('server-port'));
  const keyGenBtn = /** @type {HTMLButtonElement|null} */ (byId('server-key-generate'));
  const keyField = initServerKeyField();

  /** @type {RemoteConfig|null} */
  let remoteConfig = null;
  /** @type {RemoteState|null} */
  let remoteState = null;
  /** @type {ServerConfig|null} */
  let serverConfig = null;
  let starting = false;
  let generating = false;
  let busy = false;
  let hasNetwork = false;

  // ---- Carte client ----

  function renderBusy() {
    for (const b of [connectBtn, testBtn, manualBtn, backLocalBtn]) if (b) b.disabled = busy;
    if (connectBtn && !busy) connectBtn.disabled = !hasNetwork;
  }

  function renderState() {
    if (!stateEl) return;
    stateEl.dataset.bad = 'false';
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
    const remote = cfg.mode === 'remote';
    if (activeEl) activeEl.hidden = !remote;
    if (form) form.hidden = remote;
    if (currentUrlEl) currentUrlEl.textContent = remote ? t('settings.remote.client.current.url', { url: cfg.url || '' }) : '';
    renderState();
    renderBusy();
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

  /** @param {unknown} e */
  function discoveryMessage(e) {
    const msg = messageOf(e);
    if (msg === 'discovery_not_found') return t('settings.remote.client.discovery.notFound');
    if (msg === 'discovery_invalid_key') return t('settings.remote.client.discovery.invalidKey');
    return msg;
  }

  /**
   * Enregistre la tour puis recharge : les caches de la page (modèles, état, matériel) repartent de zéro.
   * @param {string} url @param {string|null} key
   */
  async function saveAndReload(url, key) {
    await setRemoteConfig({ mode: 'remote', url, key });
    setText(statusEl, t('settings.remote.client.current.reloading'));
    location.reload();
  }

  /** @param {ServerInterface[]} ifaces */
  function renderNetworks(ifaces) {
    if (!networkSelect) return;
    networkSelect.replaceChildren();
    const list = ifaces.filter((i) => !i.loopback);
    hasNetwork = list.length > 0;
    for (const i of list) {
      const opt = document.createElement('option');
      opt.value = i.ip;
      opt.textContent = i.wireguard
        ? t('settings.server.interface.optionWireguard', { name: i.name, ip: i.ip })
        : t('settings.server.interface.option', { name: i.name, ip: i.ip });
      networkSelect.append(opt);
    }
    if (!hasNetwork) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = t('settings.remote.client.network.none');
      networkSelect.append(opt);
      networkSelect.disabled = true;
      return;
    }
    networkSelect.disabled = false;
    networkSelect.value = (list.find((i) => !i.wireguard) ?? list[0]).ip;
  }

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !keyInput || !networkSelect || !hasNetwork) return;
    setText(errorEl, '');
    setText(statusEl, '');
    const key = keyInput.value.trim();
    if (!key) {
      setText(errorEl, t('settings.remote.client.keyRequired'));
      keyInput.focus();
      return;
    }
    busy = true;
    renderBusy();
    try {
      setText(statusEl, t('settings.remote.client.discovery.searching'));
      const found = await discoverRemote({ key, interfaceIp: networkSelect.value });
      setText(statusEl, t('settings.remote.client.discovery.found', { name: found.name, ip: found.ip }));
      await testRemote({ url: found.url, key });
      await saveAndReload(found.url, key);
      return;
    } catch (err) {
      setText(statusEl, '');
      setText(errorEl, discoveryMessage(err));
    }
    busy = false;
    renderBusy();
  });

  testBtn?.addEventListener('click', async () => {
    if (busy || !urlInput || !testBtn) return;
    setText(testError, '');
    if (testResult) testResult.hidden = true;
    const url = urlInput.value.trim();
    if (!url) {
      setText(testError, t('settings.remote.client.urlRequired'));
      urlInput.focus();
      return;
    }
    const label = testBtn.textContent;
    busy = true;
    renderBusy();
    testBtn.textContent = t('settings.remote.client.testing');
    try {
      renderTestResult(await testRemote({ url, key: keyInput?.value.trim() || null }));
    } catch (e) {
      setText(testError, messageOf(e));
    } finally {
      busy = false;
      testBtn.textContent = label;
      renderBusy();
    }
  });

  manualBtn?.addEventListener('click', async () => {
    if (busy || !urlInput) return;
    setText(testError, '');
    setText(errorEl, '');
    setText(statusEl, '');
    if (testResult) testResult.hidden = true;
    const url = urlInput.value.trim();
    if (!url) {
      setText(testError, t('settings.remote.client.urlRequired'));
      urlInput.focus();
      return;
    }
    busy = true;
    renderBusy();
    try {
      const key = keyInput?.value.trim() || null;
      await testRemote({ url, key });
      await saveAndReload(url, key);
      return;
    } catch (e) {
      setText(testError, messageOf(e));
    }
    busy = false;
    renderBusy();
  });

  backLocalBtn?.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    renderBusy();
    try {
      await setRemoteConfig({ mode: 'local', url: remoteConfig?.url ?? '', key: null });
      location.reload();
      return;
    } catch (e) {
      if (stateEl) {
        stateEl.dataset.bad = 'true';
        stateEl.textContent = messageOf(e);
      }
    }
    busy = false;
    renderBusy();
  });

  async function refreshRemoteState() {
    try {
      remoteState = await getRemoteState();
      renderState();
    } catch {
      // État indisponible : on garde l'affichage actuel.
    }
  }

  // ---- Carte serveur ----

  /** @param {ServerConfig} cfg */
  function renderServerConfig(cfg) {
    serverConfig = cfg;
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
    if (all && !allowAllInput?.checked) hint = t('settings.server.hint.needAck');
    else if (readPort() === null) hint = t('settings.server.port.invalid');
    if (hintEl) hintEl.textContent = hint;
    if (startSwitch) {
      startSwitch.disabled = starting || !!hint;
      startSwitch.setAttribute('aria-checked', starting || serverConfig?.running ? 'true' : 'false');
    }
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
    // Valeur enregistrée d'abord (choix explicite), puis WireGuard, puis la première interface non-loopback, puis la boucle locale.
    const saved = cfg.bindIp && (cfg.bindIp !== ALL_INTERFACES || cfg.allowAll) && has(cfg.bindIp) ? cfg.bindIp : null;
    const pick = saved ?? ifaces.find((i) => i.wireguard)?.ip ?? ifaces.find((i) => !i.loopback)?.ip ?? LOOPBACK;
    ifaceSelect.value = has(pick) ? pick : ALL_INTERFACES;
    if (allowAllInput) allowAllInput.checked = ifaceSelect.value === ALL_INTERFACES && cfg.allowAll;
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
      keyField.setKey(await generateServerKey());
      renderServerConfig({ ...(serverConfig ?? defaultServerConfig()), hasKey: true });
    } catch (e) {
      setText(serverErrorEl, messageOf(e));
    } finally {
      generating = false;
      keyGenBtn.disabled = false;
    }
  });

  startSwitch?.addEventListener('click', async () => {
    if (starting || !startSwitch || !ifaceSelect) return;
    if (serverConfig?.running) {
      location.replace('/serveur');
      return;
    }
    const port = readPort();
    if (port === null) {
      renderStartState();
      portInput?.focus();
      return;
    }
    setText(serverErrorEl, '');
    starting = true;
    renderStartState();
    try {
      // Pas encore de code : on le génère automatiquement avant de démarrer.
      if (!serverConfig?.hasKey) {
        keyField.setKey(await generateServerKey());
        renderServerConfig({ ...(serverConfig ?? defaultServerConfig()), hasKey: true });
      }
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
      renderNetworks(ifaces);
      renderRemoteConfig(rc);
      if (portInput) portInput.value = String(sc.port || DEFAULT_PORT);
      renderInterfaces(ifaces, sc);
      renderServerConfig(sc);
      mainEl.hidden = false;
      refreshRemoteState();
      getServerKey()
        .then((k) => keyField.setKey(k))
        .catch(() => {});
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
