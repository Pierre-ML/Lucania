// Accès distant : mode serveur (la tour partage son moteur) et mode distant (le portable relaie vers la tour). Commandes + événements Tauri.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { engineAvailable } from './engine.js';
import { t } from './i18n.js';

/**
 * @typedef {{ bindIp: string|null, port: number, allowAll: boolean, hasKey: boolean, keyPrefix: string|null, active: boolean, running: boolean, address: string|null, error: string|null }} ServerConfig
 * @typedef {{ name: string, ip: string, wireguard: boolean, loopback: boolean }} ServerInterface
 * @typedef {{ bindIp: string, port: number, allowAll: boolean }} ServerStartInput bindIp « 0.0.0.0 » seulement si allowAll est vrai
 * @typedef {'local'|'remote'} RemoteMode
 * @typedef {{ mode: RemoteMode, url: string, hasKey: boolean, keyPrefix: string|null }} RemoteConfig
 * @typedef {{ mode: RemoteMode, url: string, key?: string|null }} RemoteConfigInput key null ou absent = garder la clé enregistrée, chaîne vide = l'effacer
 * @typedef {{ url: string, key?: string|null }} RemoteTestInput key null = clé enregistrée
 * @typedef {{ latencyMs: number, version: string, backend: 'cuda'|'cpu', gpuName: string|null, vramBytes: number|null, loadedModel: string|null }} RemoteTestResult
 * @typedef {{ mode: RemoteMode, connected: boolean, error: string|null }} RemoteState
 * @typedef {{ key: string, interfaceIp: string }} RemoteDiscoverInput
 * @typedef {{ url: string, name: string, ip: string, port: number }} RemoteDiscoverResult
 */

/** Lève une erreur claire si la commande n'est pas joignable (navigateur simple). */
function requireEngine() {
  if (!engineAvailable()) throw new Error(t('chat.engine.unavailable'));
}

/** @returns {Promise<ServerConfig>} */
export async function getServerConfig() {
  requireEngine();
  return invoke('server_get_config');
}

/** Interfaces réseau proposées à l'écoute (WireGuard en premier ; 0.0.0.0 n'y figure pas).
 * @returns {Promise<ServerInterface[]>} */
export async function getServerInterfaces() {
  requireEngine();
  const list = await invoke('server_interfaces');
  return Array.isArray(list) ? list : [];
}

/** Génère la clé d'API du serveur (« code de la tour »). Elle n'est renvoyée qu'ici, en clair, une seule fois.
 * Rejette avec `role_conflict` si cette machine est déjà un récepteur.
 * @returns {Promise<string>} */
export async function generateServerKey() {
  requireEngine();
  return invoke('server_generate_key');
}

/** Supprime le serveur : arrête l'écoute, efface la clé, la machine n'a plus de rôle.
 * @returns {Promise<ServerConfig>} */
export async function deleteServer() {
  requireEngine();
  return invoke('server_delete');
}

/**
 * Rôle de cette machine : serveur si une clé existe, sinon récepteur si le mode distant est actif, sinon aucun.
 * @param {ServerConfig} server @param {RemoteConfig} remote
 * @returns {'tower'|'laptop'|null}
 */
export function roleOf(server, remote) {
  if (server.hasKey) return 'tower';
  if (remote.mode === 'remote') return 'laptop';
  return null;
}

/** Démarre le mode serveur (la fenêtre passe en plein écran côté Rust).
 * @param {ServerStartInput} input
 * @returns {Promise<ServerConfig>} */
export async function startServer(input) {
  requireEngine();
  return invoke('server_start', { ...input });
}

/** Arrête le mode serveur (quitte le plein écran côté Rust).
 * @returns {Promise<ServerConfig>} */
export async function stopServer() {
  requireEngine();
  return invoke('server_stop');
}

/**
 * Écoute les changements d'état du serveur.
 * @param {(config: ServerConfig) => void} cb
 * @returns {Promise<() => void>} fonction de désabonnement
 */
export async function onServerState(cb) {
  requireEngine();
  return listen('server://state', (event) => cb(/** @type {ServerConfig} */ (event.payload)));
}

/** @returns {Promise<RemoteConfig>} */
export async function getRemoteConfig() {
  requireEngine();
  return invoke('remote_get_config');
}

/**
 * Enregistre le mode (local ou distant), l'adresse de la tour et sa clé. Rejette avec `role_conflict` (mode distant) si cette machine est déjà un serveur.
 * @param {RemoteConfigInput} input
 * @returns {Promise<RemoteConfig>}
 */
export async function setRemoteConfig(input) {
  requireEngine();
  return invoke('remote_set_config', { mode: input.mode, url: input.url, key: input.key ?? null });
}

/**
 * Teste la connexion à une tour (erreur en chaîne française en cas d'échec).
 * @param {RemoteTestInput} input
 * @returns {Promise<RemoteTestResult>}
 */
export async function testRemote(input) {
  requireEngine();
  return invoke('remote_test', { url: input.url, key: input.key ?? null });
}

/**
 * Cherche la tour sur le réseau local à partir de son code. Rejette avec discovery_not_found,
 * discovery_invalid_key ou un autre message.
 * @param {RemoteDiscoverInput} input
 * @returns {Promise<RemoteDiscoverResult>}
 */
export async function discoverRemote(input) {
  requireEngine();
  return invoke('remote_discover', { key: input.key, interfaceIp: input.interfaceIp });
}

/** @returns {Promise<RemoteState>} */
export async function getRemoteState() {
  requireEngine();
  return invoke('remote_state');
}

/**
 * Écoute les changements d'état de la liaison avec la tour.
 * @param {(state: RemoteState) => void} cb
 * @returns {Promise<() => void>} fonction de désabonnement
 */
export async function onRemoteState(cb) {
  requireEngine();
  return listen('remote://state', (event) => cb(/** @type {RemoteState} */ (event.payload)));
}
