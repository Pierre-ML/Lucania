// Extinction à distance côté récepteur : récupère auprès de la tour comment l'éteindre, puis crée ou met à jour la « connexion » d'extinction locale.
// Partagé par l'étape « Extinction » de l'assistant et le bouton de la vue de gestion (ReceiverShutdownSync.astro, plusieurs instances : tout est ciblé par data-rshut-* dans le conteneur donné).
import { EVENT_CONNECTIONS, errorText } from './connect-state.js';
import { createConnection, listConnections, updateConnection } from './connections.js';
import { t } from './i18n.js';
import { getRemoteShutdownInfo } from './remote.js';

/**
 * @typedef {import('./remote.js').ShutdownInfo} ShutdownInfo
 * @typedef {'idle'|'loading'|'none'|'token'|'done'|'error'} SyncState
 *  none : la tour ne propose pas l'extinction ; token : le jeton est demandé ; done : connexion enregistrée.
 */

const MAX_NAME = 60;

/** Adresse comparable : sans slash final, hôte en minuscules. @param {string} value */
function comparableUrl(value) {
  const s = value.trim();
  try {
    return new URL(s).href.replace(/\/+$/, '');
  } catch {
    return s.replace(/\/+$/, '');
  }
}

/** Nom de la connexion : nom ou IP de la tour tiré de l'adresse d'extinction. @param {string} url */
function nameFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (host) return host.slice(0, MAX_NAME);
  } catch {
    // Adresse illisible : nom par défaut.
  }
  return t('settings.remote.client.shutdownSync.defaultName');
}

/** Les listes de connexions et d'extinction (onglets du mode avancé) se rechargent. */
function announceChanged() {
  // connections-settings.js écoute « shutdown », shutdown-settings.js écoute « connections ».
  for (const source of ['shutdown', 'connections']) {
    document.dispatchEvent(new CustomEvent(EVENT_CONNECTIONS, { detail: { source } }));
  }
}

/**
 * Crée la connexion d'extinction de la tour, ou met à jour celle qui a déjà la même adresse.
 * @param {ShutdownInfo} info
 * @param {string|null} token jeton saisi (jamais fourni par la tour) ; null = ne pas toucher au jeton enregistré
 * @returns {Promise<{ created: boolean }>}
 */
export async function saveTowerConnection(info, token) {
  const target = comparableUrl(info.url);
  const list = await listConnections();
  const existing = list.find((c) => c.shutdown?.url && comparableUrl(c.shutdown.url) === target);
  /** @type {{ enabled: boolean, url: string, method: 'GET'|'POST', token?: string }} */
  const shutdown = { enabled: true, url: info.url, method: info.method === 'GET' ? 'GET' : 'POST' };
  if (token) shutdown.token = token;
  if (existing) {
    await updateConnection(existing.id, { kind: 'remote', enabled: true, shutdown });
  } else {
    await createConnection({ name: nameFromUrl(info.url), kind: 'remote', enabled: true, shutdown });
  }
  announceChanged();
  return { created: !existing };
}

/**
 * @param {ParentNode} root conteneur [data-rshut]
 * @returns {{ run: () => Promise<SyncState>, getState: () => SyncState, onChange: (cb: (state: SyncState) => void) => void }}
 */
export function initReceiverShutdown(root) {
  /** @param {string} sel */
  const q = (sel) => /** @type {HTMLElement|null} */ (root.querySelector(sel));
  const runBtn = /** @type {HTMLButtonElement|null} */ (q('[data-rshut-run]'));
  const retryBtn = /** @type {HTMLButtonElement|null} */ (q('[data-rshut-retry]'));
  const statusEl = q('[data-rshut-status]');
  const errorEl = q('[data-rshut-error]');
  const tokenForm = /** @type {HTMLFormElement|null} */ (q('[data-rshut-token-form]'));
  const tokenInput = /** @type {HTMLInputElement|null} */ (q('[data-rshut-token]'));
  const tokenSaveBtn = /** @type {HTMLButtonElement|null} */ (q('[data-rshut-token-save]'));

  /** @type {SyncState} */
  let state = 'idle';
  /** @type {ShutdownInfo|null} */
  let offer = null;
  let runId = 0;
  /** @type {Set<(state: SyncState) => void>} */
  const listeners = new Set();

  /** @param {string} msg */
  function showError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  /** @param {SyncState} next @param {string} [message] @param {boolean} [bad] */
  function setState(next, message = '', bad = false) {
    state = next;
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.dataset.bad = String(bad);
      statusEl.hidden = !message;
    }
    if (tokenForm) tokenForm.hidden = next !== 'token';
    if (retryBtn) retryBtn.hidden = next !== 'error';
    if (runBtn) runBtn.disabled = next === 'loading';
    if (next !== 'token' && next !== 'error') showError('');
    for (const cb of listeners) cb(next);
  }

  /** @param {unknown} e */
  function fail(e) {
    setState('error', errorText(e), true);
  }

  async function run() {
    const id = ++runId;
    offer = null;
    if (tokenInput) tokenInput.value = '';
    setState('loading', t('settings.remote.client.shutdownSync.loading'));
    /** @type {ShutdownInfo} */
    let info;
    try {
      info = await getRemoteShutdownInfo();
    } catch (e) {
      if (id === runId) fail(e);
      return state;
    }
    if (id !== runId) return state;
    if (!info?.enabled) {
      setState('none', t('settings.remote.client.shutdownSync.none'));
      return state;
    }
    if (info.tokenRequired) {
      offer = info;
      setState('token', t('settings.remote.client.shutdownSync.tokenPrompt'));
      tokenInput?.focus();
      return state;
    }
    try {
      await saveTowerConnection(info, null);
    } catch (e) {
      if (id === runId) fail(e);
      return state;
    }
    if (id === runId) setState('done', t('settings.remote.client.shutdownSync.auto'));
    return state;
  }

  runBtn?.addEventListener('click', () => {
    run();
  });
  retryBtn?.addEventListener('click', () => {
    run();
  });

  tokenForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!offer || state !== 'token') return;
    const token = tokenInput?.value.trim() ?? '';
    if (!token) {
      showError(t('settings.remote.client.shutdownSync.tokenRequired'));
      tokenInput?.focus();
      return;
    }
    showError('');
    const id = runId;
    if (tokenSaveBtn) tokenSaveBtn.disabled = true;
    try {
      await saveTowerConnection(offer, token);
      if (id !== runId) return;
      if (tokenInput) tokenInput.value = '';
      setState('done', t('settings.remote.client.shutdownSync.saved'));
    } catch (err) {
      showError(errorText(err));
    } finally {
      if (tokenSaveBtn) tokenSaveBtn.disabled = false;
    }
  });

  return {
    run,
    getState: () => state,
    /** @param {(state: SyncState) => void} cb */
    onChange(cb) {
      listeners.add(cb);
    },
  };
}
