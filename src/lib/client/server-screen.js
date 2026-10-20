// Écran du mode serveur (/serveur) : un seul bouton pour arrêter, et l'adresse d'écoute.
import { engineAvailable } from './engine.js';
import { t } from './i18n.js';
import { getServerConfig, getServerKey, onServerState, stopServer } from './remote.js';
import { initServerKeyField } from './server-key.js';

/** @typedef {import('./remote.js').ServerConfig} ServerConfig */

/** @param {string} id */
const byId = (id) => document.getElementById(id);

const stopBtn = /** @type {HTMLButtonElement|null} */ (byId('server-stop'));
const addressEl = byId('server-address');
const errorEl = byId('server-error');
const keyField = initServerKeyField();

let stopping = false;

/** @param {unknown} e */
function messageOf(e) {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return t('settings.server.errors.generic');
}

/** @param {string} msg */
function showError(msg) {
  if (!errorEl) return;
  errorEl.textContent = msg;
  errorEl.hidden = !msg;
}

/** @param {ServerConfig} config */
function render(config) {
  if (addressEl) addressEl.textContent = config.address ? t('settings.server.screen.listening', { address: config.address }) : '';
  if (config.error) showError(config.error);
}

/** @param {ServerConfig} config */
function sync(config) {
  if (!config.running && !stopping) {
    location.replace('/');
    return;
  }
  render(config);
}

stopBtn?.addEventListener('click', async () => {
  if (stopping) return;
  stopping = true;
  showError('');
  stopBtn.disabled = true;
  stopBtn.textContent = t('settings.server.screen.stopping');
  try {
    await stopServer();
    location.replace('/connexion');
  } catch (e) {
    stopping = false;
    stopBtn.disabled = false;
    stopBtn.textContent = t('settings.server.screen.stop');
    showError(messageOf(e));
  }
});

async function init() {
  if (!engineAvailable()) {
    location.replace('/');
    return;
  }
  try {
    onServerState(sync).catch(() => {});
    sync(await getServerConfig());
    keyField.setKey(await getServerKey());
  } catch (e) {
    showError(messageOf(e));
  }
}

init();
