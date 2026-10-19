// Bouton « mise à jour » de l'en-tête (application de bureau uniquement) : vérifie les nouvelles versions
// et lance l'installation après confirmation.
import { invoke } from '@tauri-apps/api/core';
import { engineAvailable } from './engine.js';
import { confirmDialog } from './dialog.js';
import { t } from './i18n.js';

/** @typedef {{ current: string, latest: string, available: boolean, url: string }} UpdateInfo */

const NOTE_MS = 4000;
const FIRST_CHECK_MS = 3000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export function initUpdate() {
  if (!engineAvailable()) return;
  const wrap = document.getElementById('update-wrap');
  const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById('update-btn'));
  const note = document.getElementById('update-note');
  if (!wrap || !btn || !note) return;
  wrap.hidden = false;
  wrap.classList.remove('hidden');

  /** @type {UpdateInfo|null} */
  let known = null;
  let busy = false;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let noteTimer;

  const hideNote = () => {
    clearTimeout(noteTimer);
    note.hidden = true;
    note.textContent = '';
  };
  /** @param {string} text @param {boolean} [sticky] */
  const showNote = (text, sticky = false) => {
    clearTimeout(noteTimer);
    note.textContent = text;
    note.hidden = false;
    if (!sticky) noteTimer = setTimeout(hideNote, NOTE_MS);
  };

  /** @param {UpdateInfo|null} info */
  const render = (info) => {
    known = info && info.available ? info : null;
    btn.dataset.available = String(Boolean(known));
    const label = known ? t('chat.update.available', { latest: known.latest }) : t('chat.update.title');
    btn.title = label;
    btn.setAttribute('aria-label', label);
  };

  /** @returns {Promise<UpdateInfo>} */
  const check = () => /** @type {Promise<UpdateInfo>} */ (invoke('app_check_update'));

  const silentCheck = async () => {
    if (busy) return;
    try {
      render(await check());
    } catch {
      /* vérification silencieuse : erreurs ignorées */
    }
  };

  /** @param {UpdateInfo} info */
  const confirmAndInstall = async (info) => {
    const ok = await confirmDialog({
      title: t('chat.update.confirm.title'),
      message: t('chat.update.confirm.message', { latest: info.latest, current: info.current }),
      confirmLabel: t('chat.update.confirm.ok'),
      danger: false,
    });
    if (!ok) return;
    btn.disabled = true;
    showNote(t('chat.update.downloading'), true);
    try {
      await invoke('app_install_update');
    } catch (err) {
      btn.disabled = false;
      showNote(err instanceof Error ? err.message : String(err));
    }
  };

  btn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    hideNote();
    try {
      if (known) {
        await confirmAndInstall(known);
        return;
      }
      btn.dataset.checking = 'true';
      btn.disabled = true;
      /** @type {UpdateInfo} */
      let info;
      try {
        info = await check();
      } catch (err) {
        showNote(t('chat.update.error', { error: err instanceof Error ? err.message : String(err) }));
        return;
      } finally {
        btn.dataset.checking = 'false';
        btn.disabled = false;
      }
      render(info);
      if (known) await confirmAndInstall(known);
      else showNote(t('chat.update.upToDate', { current: info.current }));
    } finally {
      busy = false;
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideNote();
  });

  setTimeout(silentCheck, FIRST_CHECK_MS);
  setInterval(silentCheck, CHECK_EVERY_MS);
}
