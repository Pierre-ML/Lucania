// Section « Extinction à distance » : une carte par connexion.
//
// Choix de partage avec connections-settings.js : pas d'état commun, échange par
// `CustomEvent('lucania:connections-changed', { detail: { source } })` sur `document`.
//  - Ce module écoute source = 'connections' (liste modifiée) et recharge ses cartes.
//  - Après un enregistrement, il émet source = 'shutdown' pour que la liste des
//    connexions se mette à jour (les cartes, elles, sont conservées).
import { EVENT_CONNECTIONS } from './connect-state.js';
import { listConnections, updateConnection } from './connections.js';
import { t } from './i18n.js';
import { isOn, setOn, isHttpUrl } from './switch-utils.js';

/** @typedef {import('./connections.js').Connection} Connection */

const SAVED_MS = 2500;

/** @param {string} sel @param {ParentNode} [root] */
const $ = (sel, root = document) => root.querySelector(sel);
/** @param {string} id */
const byId = (id) => document.getElementById(id);

export function initShutdownSettings() {
  const sdListEl = byId('shutdown-list');
  const sdEmptyEl = byId('shutdown-empty');
  const sdLoadingEl = byId('shutdown-loading');
  const tplShutdown = /** @type {HTMLTemplateElement|null} */ (byId('tpl-shutdown'));
  if (!sdListEl || !tplShutdown) return;

  /** @type {Connection[]} */
  let connections = [];

  async function load() {
    try {
      connections = await listConnections();
    } catch {
      /* la section Connexions affiche l'erreur */
    }
    renderShutdown();
  }

  function renderShutdown() {
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
            const fresh = connections.find((c) => c.id === conn.id);
            if (fresh) cur = fresh.shutdown;
            document.dispatchEvent(new CustomEvent(EVENT_CONNECTIONS, { detail: { source: 'shutdown' } }));
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

  document.addEventListener(EVENT_CONNECTIONS, (e) => {
    if (/** @type {CustomEvent} */ (e).detail?.source === 'connections') load();
  });

  load();
}
