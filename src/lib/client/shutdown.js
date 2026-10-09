// Extinction des machines : un bouton par connexion dont l'extinction est activée, puis dialogue de confirmation.
import { listConnections } from './connections.js';
import { t } from './i18n.js';
import { svgIcon } from './icons.js';
import powerRaw from '../../assets/icons/power.svg?raw';

const BTN_CLASS =
  'flex w-full items-center justify-center gap-2 rounded-lg border border-danger/50 px-3 py-2 text-sm font-medium text-danger transition-colors duration-200 hover:bg-white/5';

/** @type {{ id: string, name: string }|null} */
let target = null;

async function renderShutdownButtons(zone, list, openDialog) {
  let connections;
  try {
    connections = await listConnections();
  } catch {
    return; // on garde l'état précédent
  }
  const eligible = (Array.isArray(connections) ? connections : []).filter((c) => c.shutdown && c.shutdown.enabled);
  list.replaceChildren();
  for (const c of eligible) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = BTN_CLASS;
    b.dataset.connectionId = c.id;
    const icon = document.createElement('span');
    icon.className = 'flex shrink-0';
    icon.replaceChildren(svgIcon(powerRaw, '', 16));
    const text = document.createElement('span');
    text.className = 'min-w-0 truncate';
    text.textContent = t('chat.shutdown.button', { name: c.name });
    b.append(icon, text);
    b.addEventListener('click', () => openDialog({ id: c.id, name: c.name }));
    list.appendChild(b);
  }
  zone.classList.toggle('hidden', eligible.length === 0);
}

export function initShutdown() {
  const zone = document.getElementById('shutdown-zone');
  const list = document.getElementById('shutdown-list');
  const dialog = /** @type {HTMLDialogElement|null} */ (document.getElementById('shutdown-dialog'));
  const cancel = document.getElementById('shutdown-cancel');
  const confirmBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('shutdown-confirm'));
  const message = document.getElementById('shutdown-message');
  const title = document.getElementById('shutdown-title');
  const text = document.getElementById('shutdown-text');
  if (!zone || !list || !dialog || !cancel || !confirmBtn || !message || !title || !text) return;

  const resetMessage = () => {
    message.textContent = '';
    message.classList.remove('text-red-400');
  };

  const openDialog = (conn) => {
    target = conn;
    title.textContent = t('chat.shutdown.title', { name: conn.name });
    text.textContent = t('chat.shutdown.text', { name: conn.name });
    resetMessage();
    confirmBtn.disabled = false;
    confirmBtn.textContent = t('chat.shutdown.confirm');
    dialog.showModal();
  };

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

  const refresh = () => renderShutdownButtons(zone, list, openDialog);
  refresh();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
}
