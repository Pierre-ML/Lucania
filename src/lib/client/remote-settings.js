// Section « Accès distant » de /connexion : une machine n'a qu'un rôle, serveur (tour) ou récepteur.
// Sans rôle : créer le serveur ou se connecter à une tour. Avec un rôle : gérer ce rôle (démarrer, modifier le code, supprimer). Guide WireGuard.
import { openUrl } from '@tauri-apps/plugin-opener';
import { confirmDialog } from './dialog.js';
import { engineAvailable } from './engine.js';
import { t } from './i18n.js';
import { clearWizardState, errorText, EVENT_ROLE, EVENT_SERVER_KEY } from './connect-state.js';
import { initNewKeyView } from './new-key.js';
import { initReceiverShutdown } from './receiver-shutdown.js';
import { initTowerShutdown } from './tower-shutdown.js';
import {
  deleteServer,
  discoverRemote,
  generateServerKey,
  getRemoteConfig,
  getRemoteState,
  getServerConfig,
  getServerInterfaces,
  onRemoteState,
  onServerState,
  roleOf,
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
const CONNECTING_POLLS = 8;
const CONNECTING_POLL_MS = 1000;

/** @param {string} id */
const byId = (id) => document.getElementById(id);

/** @param {unknown} e */
const messageOf = errorText;

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
  const clientTitleEl = byId('remote-card-title');
  const keyLineEl = byId('remote-key-line');
  const editBtn = /** @type {HTMLButtonElement|null} */ (byId('remote-key-edit'));
  const editForm = byId('remote-edit-form');
  const editKeyInput = /** @type {HTMLInputElement|null} */ (byId('remote-edit-key'));
  const editSaveBtn = /** @type {HTMLButtonElement|null} */ (byId('remote-edit-save'));
  const editCancelBtn = /** @type {HTMLButtonElement|null} */ (byId('remote-edit-cancel'));
  const editStatusEl = byId('remote-edit-status');
  const editErrorEl = byId('remote-edit-error');
  const deleteReceiverBtn = /** @type {HTMLButtonElement|null} */ (byId('remote-delete'));
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
  const serverCard = document.querySelector('[data-remote-card="server"]');
  const serverTitleEl = byId('server-card-title');
  const createBlock = byId('server-create-block');
  const createBtn = /** @type {HTMLButtonElement|null} */ (byId('server-create'));
  const manageBlock = byId('server-manage-block');
  const keyPrefixEl = byId('server-key-prefix');
  const startBtn = /** @type {HTMLButtonElement|null} */ (byId('server-start'));
  const deleteServerBtn = /** @type {HTMLButtonElement|null} */ (byId('server-delete'));
  const hintEl = byId('server-hint');
  const runningEl = byId('server-running');
  const serverErrorEl = byId('server-error');
  const ifaceSelect = /** @type {HTMLSelectElement|null} */ (byId('server-interface'));
  const allBlock = byId('server-all-block');
  const allowAllInput = /** @type {HTMLInputElement|null} */ (byId('server-allow-all'));
  const portInput = /** @type {HTMLInputElement|null} */ (byId('server-port'));
  const newKey = initNewKeyView(serverCard ?? document);
  // Extinction à distance : carte serveur (formulaire de la tour) et carte récepteur (récupération auprès de la tour)
  const towerShutdownRoot = serverCard?.querySelector('[data-tshut]');
  const towerShutdown = towerShutdownRoot ? initTowerShutdown(towerShutdownRoot) : null;
  const receiverShutdownRoot = activeEl?.querySelector('[data-rshut]');
  if (receiverShutdownRoot) initReceiverShutdown(receiverShutdownRoot);

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
  /** Interface utilisée pour chercher la tour depuis le formulaire de modification du code. */
  /** @type {string|null} */
  let lanIp = null;
  /** Code complet de la tour : gardé seulement jusqu'au rechargement de la page. */
  /** @type {string|null} */
  let createdKey = null;
  /** @type {'tower'|'laptop'|null|undefined} */
  let lastRole;
  let editAuto = false;
  let editDismissed = false;
  let editTouched = false;

  // ---- Rôle ----

  /** @returns {'tower'|'laptop'|null} */
  function currentRole() {
    return serverConfig && remoteConfig ? roleOf(serverConfig, remoteConfig) : null;
  }

  /** Montre la partie de chaque carte qui correspond au rôle (la page /connexion masque l'autre carte). */
  function renderRole() {
    if (!serverConfig || !remoteConfig) return;
    const role = currentRole();
    if (createBlock) createBlock.hidden = role !== null;
    if (manageBlock) manageBlock.hidden = role !== 'tower';
    if (serverTitleEl) serverTitleEl.textContent = role === 'tower' ? t('settings.server.managed.title') : t('settings.server.create.title');
    if (clientTitleEl) clientTitleEl.textContent = role === 'laptop' ? t('settings.remote.client.managed.title') : t('settings.remote.client.title');
    if (activeEl) activeEl.hidden = role !== 'laptop';
    if (form) form.hidden = role !== null;
    if (keyPrefixEl) {
      const prefix = serverConfig.keyPrefix;
      keyPrefixEl.textContent = prefix ? t('settings.server.key.prefix', { prefix }) : '';
      keyPrefixEl.hidden = !prefix || !!createdKey;
    }
    if (role === 'tower') towerShutdown?.load();
    if (lastRole !== undefined && lastRole !== role) document.dispatchEvent(new CustomEvent(EVENT_ROLE, { detail: role }));
    lastRole = role;
  }

  // ---- Carte client ----

  function renderBusy() {
    for (const b of [connectBtn, testBtn, manualBtn, editBtn, editSaveBtn, deleteReceiverBtn]) if (b) b.disabled = busy;
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
    } else if (!remoteState.error) {
      // Liaison tout juste (re)lancée, sans échec : ce n'est pas encore une erreur.
      stateEl.textContent = t('settings.remote.client.state.connecting');
    } else {
      stateEl.dataset.bad = 'true';
      stateEl.textContent = t('settings.remote.client.state.unreachable', { error: remoteState.error });
    }
    syncEditWithState();
  }

  /** @param {boolean} auto ouverture automatique (tour injoignable) */
  function openEdit(auto) {
    if (!editForm) return;
    editForm.hidden = false;
    editAuto = auto;
    if (editBtn) editBtn.hidden = true;
    if (auto) editTouched = false;
    else editKeyInput?.focus();
  }

  function closeEdit() {
    if (!editForm) return;
    editForm.hidden = true;
    editAuto = false;
    editTouched = false;
    if (editBtn) editBtn.hidden = false;
    if (editKeyInput) editKeyInput.value = '';
    setText(editErrorEl, '');
    setText(editStatusEl, '');
  }

  /** Tour injoignable : le champ de modification du code s'ouvre seul, avec l'erreur (le code reste masqué). */
  function syncEditWithState() {
    if (!remoteState || currentRole() !== 'laptop' || !editForm) return;
    if (remoteState.connected) {
      if (editAuto && !editTouched && !editKeyInput?.value) closeEdit();
      return;
    }
    // Connexion en cours (aucune erreur encore) : on n'ouvre pas le formulaire de modification du code.
    if (!remoteState.error) return;
    if (editForm.hidden && !editDismissed) openEdit(true);
    if (!editForm.hidden && !editTouched) {
      setText(editErrorEl, t('settings.remote.client.state.unreachable', { error: remoteState.error }));
    }
  }

  /** @param {RemoteConfig} cfg */
  function renderRemoteConfig(cfg) {
    remoteConfig = cfg;
    const remote = cfg.mode === 'remote';
    if (currentUrlEl) currentUrlEl.textContent = remote ? t('settings.remote.client.current.url', { url: cfg.url || '' }) : '';
    if (keyLineEl) keyLineEl.textContent = cfg.keyPrefix ? t('settings.remote.client.current.key', { prefix: cfg.keyPrefix }) : t('settings.remote.client.current.noKey');
    renderRole();
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
   * @param {string} url @param {string|null} key @param {HTMLElement|null} [status]
   */
  async function saveAndReload(url, key, status = statusEl) {
    const saved = await setRemoteConfig({ mode: 'remote', url, key });
    // Relit la configuration côté moteur : on ne recharge que si le récepteur est vraiment enregistré.
    const stored = await getRemoteConfig();
    if (saved.mode !== 'remote' || stored.mode !== 'remote' || !stored.url || !stored.hasKey) {
      throw new Error(t('settings.remote.client.saveFailed'));
    }
    setText(status, t('settings.remote.client.current.reloading'));
    location.reload();
  }

  /**
   * Réseau proposé par défaut : un vrai réseau local avant WireGuard et les cartes virtuelles (WSL, Hyper-V…),
   * sur lesquelles la recherche de la tour échoue.
   * @param {ServerInterface[]} list interfaces hors boucle locale
   */
  function preferredLan(list) {
    const virtual = /vethernet|wsl|hyper-v|virtualbox|vmware|docker|bluetooth/i;
    return list.find((i) => !i.wireguard && !virtual.test(i.name)) ?? list.find((i) => !i.wireguard) ?? list[0];
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
    networkSelect.value = preferredLan(list)?.ip ?? list[0].ip;
  }

  /** @param {ServerInterface[]} ifaces */
  function pickLanIp(ifaces) {
    lanIp = preferredLan(ifaces.filter((i) => !i.loopback))?.ip ?? null;
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

  editBtn?.addEventListener('click', () => {
    editDismissed = false;
    openEdit(false);
  });

  editCancelBtn?.addEventListener('click', () => {
    editDismissed = true;
    closeEdit();
  });

  editKeyInput?.addEventListener('input', () => {
    editTouched = true;
  });

  editForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !editKeyInput) return;
    editTouched = true;
    setText(editErrorEl, '');
    const key = editKeyInput.value.trim();
    if (!key) {
      setText(editErrorEl, t('settings.remote.client.keyRequired'));
      editKeyInput.focus();
      return;
    }
    busy = true;
    renderBusy();
    setText(editStatusEl, t('settings.remote.client.edit.checking'));
    /** @type {string|null} */
    let target = null;
    let failure = '';
    const url = remoteConfig?.url ?? '';
    try {
      if (!url) throw new Error(t('settings.remote.client.urlRequired'));
      await testRemote({ url, key });
      target = url;
    } catch (err) {
      failure = messageOf(err);
    }
    // L'adresse enregistrée ne répond plus (ou le code a changé) : on cherche la tour sur le réseau.
    if (!target && lanIp) {
      try {
        setText(editStatusEl, t('settings.remote.client.discovery.searching'));
        const found = await discoverRemote({ key, interfaceIp: lanIp });
        await testRemote({ url: found.url, key });
        target = found.url;
      } catch (err) {
        failure = discoveryMessage(err);
      }
    }
    setText(editStatusEl, '');
    if (target) {
      try {
        await saveAndReload(target, key, editStatusEl);
        return;
      } catch (err) {
        failure = messageOf(err);
      }
    }
    setText(editErrorEl, failure);
    busy = false;
    renderBusy();
  });

  deleteReceiverBtn?.addEventListener('click', async () => {
    if (busy) return;
    const ok = await confirmDialog({
      title: t('settings.remote.client.delete.title'),
      message: t('settings.remote.client.delete.message'),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    busy = true;
    renderBusy();
    try {
      await setRemoteConfig({ mode: 'local', url: '', key: '' });
      clearWizardState();
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

  /** @param {number} [attempt] */
  async function refreshRemoteState(attempt = 0) {
    try {
      remoteState = await getRemoteState();
      renderState();
    } catch {
      // État indisponible : on garde l'affichage actuel.
      return;
    }
    // Juste après un enregistrement, la liaison met un instant à s'établir : on relit quelques fois (l'événement de la tour peut aussi arriver avant l'écoute).
    if (remoteState.mode === 'remote' && !remoteState.connected && !remoteState.error && attempt < CONNECTING_POLLS) {
      setTimeout(() => refreshRemoteState(attempt + 1), CONNECTING_POLL_MS);
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
    renderRole();
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
    if (startBtn) startBtn.disabled = starting || !!hint;
    if (deleteServerBtn) deleteServerBtn.disabled = starting;
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

  /**
   * Le serveur existe maintenant : le code complet reste affiché jusqu'au rechargement, la carte passe en gestion.
   * @param {string} key
   */
  function applyCreatedKey(key) {
    createdKey = key;
    newKey.show(key);
    renderServerConfig({ ...(serverConfig ?? defaultServerConfig()), hasKey: true, keyPrefix: key.slice(0, 4) });
  }

  createBtn?.addEventListener('click', async () => {
    if (generating || !createBtn) return;
    setText(serverErrorEl, '');
    generating = true;
    createBtn.disabled = true;
    try {
      applyCreatedKey(await generateServerKey());
    } catch (e) {
      setText(serverErrorEl, messageOf(e));
    } finally {
      generating = false;
      createBtn.disabled = false;
    }
  });

  // Le code a été créé par l'assistant (étape « récapitulatif ») : on le garde aussi ici.
  document.addEventListener(EVENT_SERVER_KEY, (e) => {
    const key = /** @type {CustomEvent<string>} */ (e).detail;
    if (typeof key === 'string' && key) applyCreatedKey(key);
  });

  startBtn?.addEventListener('click', async () => {
    if (starting || !startBtn || !ifaceSelect) return;
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

  deleteServerBtn?.addEventListener('click', async () => {
    if (starting || !deleteServerBtn) return;
    const ok = await confirmDialog({
      title: t('settings.server.delete.title'),
      message: t('settings.server.delete.message'),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    setText(serverErrorEl, '');
    starting = true;
    renderStartState();
    try {
      await deleteServer();
      clearWizardState();
      location.reload();
      return;
    } catch (e) {
      setText(serverErrorEl, messageOf(e));
    }
    starting = false;
    renderStartState();
  });

  /** @returns {ServerConfig} */
  function defaultServerConfig() {
    return { bindIp: null, port: DEFAULT_PORT, allowAll: false, hasKey: false, keyPrefix: null, active: false, running: false, address: null, error: null };
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
      // La liste des réseaux n'est pas indispensable : sans elle, l'adresse manuelle reste utilisable.
      const [rc, sc, ifaces] = await Promise.all([getRemoteConfig(), getServerConfig(), getServerInterfaces().catch(() => [])]);
      // Les deux configurations sont connues avant le premier rendu : le rôle se déduit des deux.
      remoteConfig = rc;
      serverConfig = sc;
      renderNetworks(ifaces);
      pickLanIp(ifaces);
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
