// Rôle de la machine (serveur, récepteur ou aucun) et libellé du lien de la barre latérale.
import { engineAvailable } from './engine.js';
import { t } from './i18n.js';
import { getRemoteConfig, getServerConfig } from './remote.js';

/**
 * Rôle de la machine : 'server' si un code existe, 'receiver' si le mode distant est actif, sinon null.
 * @returns {Promise<'server'|'receiver'|null>}
 */
export async function getMachineRole() {
  if (!engineAvailable()) return null;
  try {
    const server = await getServerConfig();
    if (server?.hasKey) return 'server';
    const remote = await getRemoteConfig();
    return remote?.mode === 'remote' ? 'receiver' : null;
  } catch {
    return null;
  }
}

/** Remplace le libellé `[data-connect-label]` selon le rôle de la machine. */
export function initRoleNavLabel() {
  const label = document.querySelector('[data-connect-label]');
  if (!label) return;
  getMachineRole().then((role) => {
    if (role === 'server') label.textContent = t('chat.sidebar.serverMode');
    else if (role === 'receiver') label.textContent = t('chat.sidebar.receiverMode');
  });
}
