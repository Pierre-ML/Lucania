// Popup de confirmation personnalisé (remplace confirm()).
import { t } from './i18n.js';

/** @type {Promise<boolean>|null} */
let pending = null;

/**
 * @param {{ title: string, message: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean }} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message, confirmLabel = t('common.delete'), cancelLabel = t('common.cancel'), danger = true }) {
  if (pending) return pending.then(() => confirmDialog({ title, message, confirmLabel, cancelLabel, danger }));
  const dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('confirm-dialog'));
  const titleEl = document.getElementById('confirm-title');
  const msgEl = document.getElementById('confirm-message');
  const okBtn = document.getElementById('confirm-ok');
  const cancelBtn = document.getElementById('confirm-cancel');
  if (!dlg || !titleEl || !msgEl || !okBtn || !cancelBtn) return Promise.resolve(false);

  titleEl.textContent = title;
  msgEl.textContent = message;
  okBtn.textContent = confirmLabel;
  cancelBtn.textContent = cancelLabel;
  okBtn.dataset.danger = danger ? 'true' : 'false';
  const previous = /** @type {HTMLElement|null} */ (document.activeElement);

  pending = new Promise((resolve) => {
    let result = false;
    const onOk = () => {
      result = true;
      dlg.close();
    };
    const onCancel = () => {
      result = false;
      dlg.close();
    };
    const onEsc = (e) => {
      e.preventDefault();
      onCancel();
    };
    const onBackdrop = (e) => {
      if (e.target === dlg) onCancel();
    };
    const onClose = () => {
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onEsc);
      dlg.removeEventListener('click', onBackdrop);
      dlg.removeEventListener('close', onClose);
      pending = null;
      if (previous && previous.isConnected) previous.focus();
      resolve(result);
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onEsc);
    dlg.addEventListener('click', onBackdrop);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    cancelBtn.focus();
  });
  return pending;
}
