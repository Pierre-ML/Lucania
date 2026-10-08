// Client API partagé pour les connexions Ollama (utilisé par la page Paramètres et le chat).

/**
 * @typedef {Object} ShutdownConfig
 * @property {boolean} enabled
 * @property {string} url
 * @property {'GET'|'POST'} method
 * @property {boolean} hasToken
 */

/**
 * @typedef {Object} Connection
 * @property {string} id
 * @property {string} name
 * @property {'local'|'remote'} kind
 * @property {string} baseUrl
 * @property {boolean} enabled
 * @property {boolean} autoModels
 * @property {string[]} manualModels
 * @property {ShutdownConfig} shutdown
 * @property {number} position
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} ConnectionInput
 * @property {string} [name]
 * @property {'local'|'remote'} [kind]
 * @property {string} [baseUrl]
 * @property {boolean} [enabled]
 * @property {boolean} [autoModels]
 * @property {string[]} [manualModels]
 * @property {{ enabled?: boolean, url?: string, method?: 'GET'|'POST', token?: string }} [shutdown]
 *   token : chaîne = remplace (vide = efface), absent = inchangé.
 */

/**
 * @typedef {Object} TestResult
 * @property {boolean} ok
 * @property {number} latencyMs
 * @property {string[]} models
 * @property {string} version
 * @property {string} error
 */

/**
 * @typedef {Object} ModelEntry
 * @property {string} connectionId
 * @property {string} connectionName
 * @property {'local'|'remote'} kind
 * @property {string} name
 * @property {'installed'|'manual'|'both'} source
 * @property {boolean} available
 */

/**
 * @typedef {Object} Status
 * @property {boolean} online
 * @property {{ id: string, name: string, kind: 'local'|'remote', online: boolean, latencyMs: number }[]} connections
 */

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function request(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error('Serveur injoignable.');
  }
  if (!res.ok) {
    let message = `Erreur ${res.status}`;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string' && body.error) message = body.error;
    } catch {
      /* corps non JSON */
    }
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

/** @param {string} method @param {unknown} [body] */
function jsonInit(method, body) {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

/** @returns {Promise<Connection[]>} */
export function listConnections() {
  return request('/api/connections');
}

/** @param {ConnectionInput} input @returns {Promise<Connection>} */
export function createConnection(input) {
  return request('/api/connections', jsonInit('POST', input));
}

/** @param {string} id @param {ConnectionInput} input @returns {Promise<Connection>} */
export function updateConnection(id, input) {
  return request(`/api/connections/${encodeURIComponent(id)}`, jsonInit('PATCH', input));
}

/** @param {string} id @returns {Promise<void>} */
export async function deleteConnection(id) {
  await request(`/api/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** @param {string} baseUrl @returns {Promise<TestResult>} */
export function testConnectionUrl(baseUrl) {
  return request('/api/connections/test', jsonInit('POST', { baseUrl }));
}

/** @param {string} id @returns {Promise<TestResult>} */
export function testConnection(id) {
  return request(`/api/connections/${encodeURIComponent(id)}/test`, jsonInit('POST'));
}

/** @returns {Promise<ModelEntry[]>} */
export async function listModels() {
  const data = await request('/api/models');
  return Array.isArray(data?.models) ? data.models : [];
}

/** @returns {Promise<Status>} */
export async function getStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return { online: false, connections: [] };
    const data = await res.json();
    return {
      online: Boolean(data?.online),
      connections: Array.isArray(data?.connections) ? data.connections : [],
    };
  } catch {
    return { online: false, connections: [] };
  }
}
