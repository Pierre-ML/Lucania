// Page Paramètres, section Hugging Face : jeton d'accès (modèles à accès restreint).
// La recherche et le téléchargement de modèles sont dans la fenêtre « Ajouter un modèle » (hf-browser.js).
import { openUrl } from '@tauri-apps/plugin-opener';
import { engineAvailable } from './engine.js';
import { errorMessage, getTokenStatus, setToken } from './hf.js';
import { t } from './i18n.js';

/** @typedef {import('./hf.js').TokenStatus} TokenStatus */

const TOKENS_URL = 'https://huggingface.co/settings/tokens';

/** @param {string} id */
const byId = (id) => document.getElementById(id);

const unavailableEl = byId('hf-unavailable');
const errorEl = byId('hf-error');
const mainEl = byId('hf-main');
const tokenStatusEl = byId('hf-token-status');
const tokenForm = byId('hf-token-form');
const tokenInput = /** @type {HTMLInputElement|null} */ (byId('hf-token-input'));
const tokenSaveBtn = /** @type {HTMLButtonElement|null} */ (byId('hf-token-save'));
const tokenClearBtn = /** @type {HTMLButtonElement|null} */ (byId('hf-token-clear'));
const tokenLink = byId('hf-token-link');

/** @param {string} msg */
function showError(msg) {
  if (!errorEl) return;
  errorEl.textContent = msg;
  errorEl.hidden = !msg;
}

/** Exécute une action en désactivant son bouton ; l'erreur va dans la zone d'erreur.
 * @param {HTMLButtonElement} btn @param {() => Promise<unknown>} fn */
async function guarded(btn, fn) {
  showError('');
  btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    showError(errorMessage(e));
  } finally {
    btn.disabled = false;
  }
}

/** @param {TokenStatus} st */
function renderToken(st) {
  if (tokenStatusEl) {
    tokenStatusEl.textContent = !st.hasToken
      ? t('settings.hf.token.none')
      : st.user
        ? t('settings.hf.token.connected', { user: st.user })
        : t('settings.hf.token.saved');
  }
  if (tokenClearBtn) tokenClearBtn.hidden = !st.hasToken;
}

async function loadToken() {
  try {
    renderToken(await getTokenStatus());
  } catch (e) {
    showError(errorMessage(e));
  }
}

tokenForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!tokenInput || !tokenSaveBtn || tokenSaveBtn.disabled) return;
  const value = tokenInput.value.trim();
  if (!value) {
    tokenInput.focus();
    return;
  }
  showError('');
  tokenSaveBtn.disabled = true;
  const label = tokenSaveBtn.textContent;
  tokenSaveBtn.textContent = t('settings.hf.token.saving');
  try {
    renderToken(await setToken(value));
    tokenInput.value = '';
  } catch (err) {
    showError(errorMessage(err));
  } finally {
    tokenSaveBtn.disabled = false;
    tokenSaveBtn.textContent = label;
  }
});

tokenClearBtn?.addEventListener('click', () => {
  guarded(tokenClearBtn, async () => {
    renderToken(await setToken(null));
    if (tokenInput) tokenInput.value = '';
  });
});

tokenLink?.addEventListener('click', async () => {
  try {
    await openUrl(TOKENS_URL);
  } catch (e) {
    showError(errorMessage(e));
  }
});

if (mainEl && unavailableEl) {
  if (engineAvailable()) {
    mainEl.hidden = false;
    loadToken();
  } else {
    unavailableEl.textContent = t('chat.engine.unavailable');
    unavailableEl.hidden = false;
  }
}
