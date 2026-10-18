// Client API partagé pour les connexions (extinction à distance d'une machine).

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
 * @property {boolean} enabled
 * @property {ShutdownConfig} shutdown
 * @property {number} position
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} ConnectionInput
 * @property {string} [name]
 * @property {'local'|'remote'} [kind]
 * @property {boolean} [enabled]
 * @property {{ enabled?: boolean, url?: string, method?: 'GET'|'POST', token?: string }} [shutdown]
 *   token : chaîne = remplace (vide = efface), absent = inchangé.
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
