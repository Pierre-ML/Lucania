// Garde du mode serveur : tant que le serveur tourne, la fenêtre reste sur l'écran /serveur.
import { engineAvailable } from './engine.js';
import { getServerConfig, onServerState } from './remote.js';

const SERVER_PATH = '/serveur';

/** Redirige vers l'écran du mode serveur si le serveur tourne (ou démarre plus tard). */
export async function guardServerMode() {
  if (!engineAvailable()) return;
  try {
    onServerState((config) => {
      if (config.running) location.replace(SERVER_PATH);
    }).catch(() => {});
    const config = await getServerConfig();
    if (config.running) location.replace(SERVER_PATH);
  } catch {
    // Commande indisponible : on laisse la page normale.
  }
}
