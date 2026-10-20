// Bouton marche/arrêt de l'en-tête : reflète l'état du moteur (couleur) et ouvre la confirmation d'extinction
// de la première connexion dont l'extinction est activée.
import { listConnections } from './connections.js';
import { engineAvailable } from './engine.js';
import { t } from './i18n.js';

/** @typedef {'ok'|'partial'|'none'} PowerState */
/**
 * Entrée de la pastille. En mode distant (remote), l'état est celui de la tour : `error` = tour injoignable,
 * `remoteError` = message d'erreur éventuel.
 * @typedef {{ engineAvailable: boolean, status: import('./engine.js').EngineStatus|null, error?: boolean, remote?: boolean, remoteError?: string|null }} PowerInput
 */

/** Durée d'affichage de la note « aucune machine à éteindre ». */
const NOTE_MS = 3500;

/**
 * Couleur du bouton : ok (vert) = modèle prêt, partial (orange) = moteur joignable sans modèle ou chargement,
 * none (gris) = aucun signal ou tour injoignable. Même règle en mode local et en mode distant (état de la tour).
 * @param {PowerInput} input
 * @returns {PowerState}
 */
export function computePowerState({ engineAvailable: available, status, error = false }) {
  if (!available || error || !status) return 'none';
  if (status.loading) return 'partial';
  if (status.generating || status.loadedModel) return 'ok';
  return 'partial';
}

/** @param {PowerInput} input */
function statusLabel({ engineAvailable: available, status, error = false, remote = false, remoteError = null }) {
  if (remote) {
    if (!available || error) {
      return remoteError ? t('common.remote.unreachableWithError', { error: remoteError }) : t('common.remote.unreachable');
    }
    if (!status) return t('common.remote.checking');
    if (status.loading) return t('common.remote.loading');
    if (status.generating) return t('common.remote.generating');
    if (status.loadedModel) return t('common.remote.ready');
    return t('common.remote.idle');
  }
  if (!available) return t('chat.engine.unavailable');
  if (error) return t('chat.power.error');
  if (!status) return t('chat.status.checking');
  if (status.loading) return t('chat.engine.loading');
  if (status.generating) return t('chat.engine.generating');
  if (status.loadedModel) return t('chat.engine.ready');
  return t('chat.engine.idle');
}

/** Dernier état du moteur reçu de app.js. @type {{ engineAvailable: boolean, status: import('./engine.js').EngineStatus|null, error: boolean, remote: boolean, remoteError: string|null }} */
let power = { engineAvailable: engineAvailable(), status: null, error: false, remote: false, remoteError: null };
/** Connexion à éteindre (première dont l'extinction est activée), ou null. @type {{ id: string, name: string }|null} */
let target = null;
/** @type {(() => void)|null} */
let renderPower = null;

/**
 * Met à jour la couleur et l'infobulle du bouton.
 * @param {PowerInput} input
 */
export function setPowerStatus(input) {
  power = {
    engineAvailable: input.engineAvailable,
    status: input.status,
    error: Boolean(input.error),
    remote: Boolean(input.remote),
    remoteError: input.remoteError || null,
  };
  if (renderPower) renderPower();
}

/** Première connexion dont l'extinction est activée, ou null (liste illisible : on garde l'état précédent). */
async function findTarget() {
  let connections;
  try {
    connections = await listConnections();
  } catch {
    return undefined;
  }
  const all = Array.isArray(connections) ? connections : Array.isArray(connections?.connections) ? connections.connections : [];
  const c = all.find((x) => x.shutdown && x.shutdown.enabled);
  return c ? { id: c.id, name: c.name } : null;
}

export function initShutdown() {
  const btn = document.getElementById('power-btn');
  const note = document.getElementById('power-note');
  const dialog = /** @type {HTMLDialogElement|null} */ (document.getElementById('shutdown-dialog'));
  const cancel = document.getElementById('shutdown-cancel');
  const confirmBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('shutdown-confirm'));
  const message = document.getElementById('shutdown-message');
  const title = document.getElementById('shutdown-title');
  const text = document.getElementById('shutdown-text');
  if (!btn || !note || !dialog || !cancel || !confirmBtn || !message || !title || !text) return;

  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let noteTimer;
  const hideNote = () => {
    clearTimeout(noteTimer);
    note.hidden = true;
    note.textContent = '';
  };

  renderPower = () => {
    const label = statusLabel(power);
    const model = power.status && power.status.loadedModel ? ` · ${power.status.loadedModel}` : '';
    const action = target ? t('chat.power.clickToShutdown', { name: target.name }) : '';
    btn.dataset.state = computePowerState(power);
    // Sans machine distante configurée : simple témoin d'état du moteur, non cliquable (pas d'extinction possible).
    btn.dataset.actionable = String(Boolean(target));
    btn.tabIndex = target ? 0 : -1;
    btn.dataset.loading = String(Boolean(power.engineAvailable && !power.error && power.status && power.status.loading));
    btn.title = action ? `${label}${model}\n${action}` : `${label}${model}`;
    btn.setAttribute('aria-label', action ? `${label}${model}. ${action}` : `${label}${model}`);
  };
  renderPower();

  const resetMessage = () => {
    message.textContent = '';
    message.classList.remove('text-red-400');
  };

  /** @param {{ id: string, name: string }} conn */
  const openDialog = (conn) => {
    hideNote();
    title.textContent = t('chat.shutdown.title', { name: conn.name });
    text.textContent = t('chat.shutdown.text', { name: conn.name });
    resetMessage();
    confirmBtn.disabled = false;
    confirmBtn.textContent = t('chat.shutdown.confirm');
    dialog.showModal();
  };

  btn.addEventListener('click', () => {
    if (target) {
      openDialog(target);
      return;
    }
    // Rien à éteindre : on l'explique, sans rien déclencher.
    note.textContent = t('chat.power.noTarget');
    note.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(hideNote, NOTE_MS);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideNote();
  });

  cancel.addEventListener('click', () => dialog.close());

  confirmBtn.addEventListener('click', async () => {
    if (!target) return;
    const { id, name } = target;
    confirmBtn.disabled = true;
    confirmBtn.textContent = t('chat.shutdown.inProgress');
    resetMessage();
    try {
      const r = await fetch('/api/shutdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: id, confirm: true }),
      });
      let data = null;
      try {
        data = await r.json();
      } catch {
        /* corps non JSON */
      }
      if (r.ok && data && data.ok) {
        message.textContent = t('chat.shutdown.sent', { name });
        setTimeout(() => dialog.close(), 2500);
      } else {
        throw new Error((data && data.error) || t('chat.errors.http', { status: r.status }));
      }
    } catch (err) {
      message.textContent = err instanceof Error ? err.message : String(err);
      message.classList.add('text-red-400');
      confirmBtn.disabled = false;
      confirmBtn.textContent = t('chat.shutdown.confirm');
    }
  });

  const refresh = async () => {
    const found = await findTarget();
    if (found === undefined) return;
    target = found;
    renderPower?.();
  };
  refresh();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
}
