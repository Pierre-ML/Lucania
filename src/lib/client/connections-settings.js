// Section « Connexions » : liste, menu modifier/supprimer, formulaire d'ajout/édition.
//
// Choix de partage avec shutdown-settings.js : pas d'état commun. Les deux modules
// échangent par l'événement `CustomEvent('lucania:connections-changed', { detail: { source } })`
// émis sur `document`.
//  - Ce module émet source = 'connections' après chaque rechargement de la liste ;
//    l'extinction se rafraîchit alors.
//  - Il écoute source = 'shutdown' (enregistrement d'une carte d'extinction) et
//    recharge/redessine sa liste, sans ré-émettre (pas de boucle).
import {
  listConnections,
  createConnection,
  updateConnection,
  deleteConnection,
} from './connections.js';
import { confirmDialog } from './dialog.js';
import { t } from './i18n.js';
import { isOn, setOn, isHttpUrl } from './switch-utils.js';

/** @typedef {import('./connections.js').Connection} Connection */

export const CONNECTIONS_CHANGED = 'lucania:connections-changed';

/** @param {string} sel @param {ParentNode} [root] */
const $ = (sel, root = document) => root.querySelector(sel);
/** @param {string} id */
const byId = (id) => document.getElementById(id);

export function initConnectionsSettings() {
  const listEl = byId('connections-list');
  const emptyEl = byId('connections-empty');
  const loadingEl = byId('connections-loading');
  const feedbackEl = byId('connections-feedback');
  const tplConn = /** @type {HTMLTemplateElement|null} */ (byId('tpl-connection'));

  const dlg = /** @type {HTMLDialogElement|null} */ (byId('connection-dialog'));
  const form = /** @type {HTMLFormElement|null} */ (byId('connection-form'));
  const titleEl = byId('cf-title');
  const errorBanner = byId('cf-error');
  const nameInput = /** @type {HTMLInputElement|null} */ (byId('cf-name'));
  const kindSelect = /** @type {HTMLSelectElement|null} */ (byId('cf-kind'));
  const sdSwitch = /** @type {HTMLButtonElement|null} */ (byId('cf-sd-enabled'));
  const sdFields = byId('cf-sd-fields');
  const sdUrl = /** @type {HTMLInputElement|null} */ (byId('cf-sd-url'));
  const sdMethod = /** @type {HTMLSelectElement|null} */ (byId('cf-sd-method'));
  const sdToken = /** @type {HTMLInputElement|null} */ (byId('cf-sd-token'));
  const sdClearWrap = byId('cf-sd-clear-wrap');
  const sdClear = /** @type {HTMLInputElement|null} */ (byId('cf-sd-clear'));
  const saveBtn = /** @type {HTMLButtonElement|null} */ (byId('cf-save'));
  const saveLabel = byId('cf-save-label');

  if (
    !listEl || !tplConn || !dlg || !form || !titleEl || !errorBanner || !nameInput || !kindSelect ||
    !sdSwitch || !sdFields || !sdUrl || !sdMethod || !sdToken || !sdClearWrap || !sdClear || !saveBtn || !saveLabel
  ) {
    return;
  }

  /** @type {Connection[]} */
  let connections = [];
  /** @type {string|null} */
  let editingId = null;
  let busy = false;

  // ---------- Menu « ⋯ » (un seul ouvert à la fois) ----------

  /** @type {HTMLElement|null} */
  let openWrap = null;

  /** @param {{ restoreFocus?: boolean }} [opts] */
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

  /** @param {{ emit?: boolean }} [opts] */
  async function refresh({ emit = true } = {}) {
    try {
      connections = await listConnections();
      showFeedback('');
    } catch (e) {
      showFeedback(e.message);
    }
    renderList();
    if (emit) document.dispatchEvent(new CustomEvent(CONNECTIONS_CHANGED, { detail: { source: 'connections' } }));
  }

  // L'extinction a enregistré une carte : on met la liste à jour sans ré-émettre.
  document.addEventListener(CONNECTIONS_CHANGED, (e) => {
    if (/** @type {CustomEvent} */ (e).detail?.source === 'shutdown') refresh({ emit: false });
  });

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
  $('[data-action="cancel"]', dlg)?.addEventListener('click', closeForm);

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

  refresh();
}
