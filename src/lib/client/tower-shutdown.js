// Formulaire « Extinction à distance de cette tour » (TowerShutdownForm.astro).
// Le formulaire peut apparaître deux fois dans la page (étape de l'assistant et carte du serveur) : tout est ciblé par data-tshut-* dans le conteneur donné.
import { errorText } from './connect-state.js';
import { t } from './i18n.js';
import { getServerShutdown, setServerShutdown } from './remote.js';
import { isHttpUrl } from './switch-utils.js';

const SAVED_MS = 2500;

/**
 * @param {ParentNode} root conteneur [data-tshut]
 * @returns {{ load: () => Promise<void>, save: () => Promise<boolean> }}
 */
export function initTowerShutdown(root) {
  /** @param {string} sel */
  const q = (sel) => /** @type {HTMLElement|null} */ (root.querySelector(sel));
  const choiceBtns = /** @type {HTMLButtonElement[]} */ ([...root.querySelectorAll('[data-tshut-choice]')]);
  const methodBtns = /** @type {HTMLButtonElement[]} */ ([...root.querySelectorAll('[data-tshut-method] [data-method]')]);
  const fields = q('[data-tshut-fields]');
  const urlInput = /** @type {HTMLInputElement|null} */ (q('[data-tshut-url]'));
  const tokenInput = /** @type {HTMLInputElement|null} */ (q('[data-tshut-token]'));
  const errorEl = q('[data-tshut-error]');
  const savedEl = q('[data-tshut-saved]');
  const saveBtn = /** @type {HTMLButtonElement|null} */ (q('[data-tshut-save]'));

  let enabled = false;
  /** @type {'GET'|'POST'} */
  let method = 'POST';
  let loaded = false;
  /** @type {Promise<void>|null} */
  let loading = null;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let savedTimer;

  /** @param {string} msg */
  function showError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function clearInvalid() {
    urlInput?.setAttribute('aria-invalid', 'false');
  }

  /** @param {boolean} on */
  function setEnabled(on) {
    enabled = on;
    for (const b of choiceBtns) b.setAttribute('aria-checked', String((b.dataset.tshutChoice === 'yes') === on));
    if (fields) fields.hidden = !on;
  }

  /** @param {'GET'|'POST'} m */
  function setMethod(m) {
    method = m;
    for (const b of methodBtns) b.setAttribute('aria-checked', String(b.dataset.method === m));
  }

  /** @param {import('./remote.js').ShutdownInfo} info */
  function apply(info) {
    setEnabled(!!info.enabled);
    if (urlInput) urlInput.value = info.url || '';
    setMethod(info.method === 'GET' ? 'GET' : 'POST');
    if (tokenInput) tokenInput.checked = !!info.tokenRequired;
    clearInvalid();
  }

  /** @param {boolean} busy */
  function setBusy(busy) {
    if (saveBtn) saveBtn.disabled = busy;
  }

  function flashSaved() {
    if (!savedEl) return;
    savedEl.hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      savedEl.hidden = true;
    }, SAVED_MS);
  }

  for (const b of choiceBtns) {
    b.addEventListener('click', () => {
      setEnabled(b.dataset.tshutChoice === 'yes');
      showError('');
      if (enabled) urlInput?.focus();
    });
  }
  for (const b of methodBtns) {
    b.addEventListener('click', () => setMethod(b.dataset.method === 'GET' ? 'GET' : 'POST'));
  }
  urlInput?.addEventListener('input', () => {
    clearInvalid();
    showError('');
  });

  /** Lit la configuration actuelle de la tour (une seule fois réussie par page ; une erreur est affichée dans le formulaire). */
  function load() {
    if (loaded) return Promise.resolve();
    loading ??= (async () => {
      try {
        apply(await getServerShutdown());
        loaded = true;
        showError('');
      } catch (e) {
        showError(errorText(e));
      }
    })().finally(() => {
      loading = null;
    });
    return loading;
  }

  /**
   * Valide puis enregistre. Vrai si l'extinction est enregistrée ; sinon l'erreur est affichée dans le formulaire.
   * @returns {Promise<boolean>}
   */
  async function save() {
    showError('');
    const url = urlInput?.value.trim() ?? '';
    if (enabled && !isHttpUrl(url)) {
      urlInput?.setAttribute('aria-invalid', 'true');
      showError(t('settings.server.shutdown.errors.url'));
      urlInput?.focus();
      return false;
    }
    setBusy(true);
    try {
      apply(await setServerShutdown({ enabled, url, method, tokenRequired: !!tokenInput?.checked }));
      loaded = true;
      flashSaved();
      return true;
    } catch (e) {
      showError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  saveBtn?.addEventListener('click', () => {
    save();
  });

  return { load, save };
}
