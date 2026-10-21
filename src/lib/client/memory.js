// Client API partagé pour la mémoire par modèle (utilisé par la page Paramètres et le chat).
import { generateText, splitModel } from './engine.js';

/**
 * @typedef {Object} Fact
 * @property {string} id
 * @property {string} model
 * @property {string} content
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} MemorySettings
 * @property {string} model
 * @property {boolean} enabled
 * @property {boolean} autoExtract
 */

/**
 * @typedef {Object} MemoryState
 * @property {string} model
 * @property {boolean} enabled
 * @property {boolean} autoExtract
 * @property {Fact[]} facts
 */

/**
 * @typedef {Object} MemoryModel
 * @property {string} model
 * @property {number} count
 * @property {boolean} enabled
 * @property {boolean} autoExtract
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

/** @param {string} model @returns {Promise<MemoryState>} */
export function getMemory(model) {
  return request(`/api/memory?model=${encodeURIComponent(model)}`);
}

/** @returns {Promise<MemoryModel[]>} */
export async function listMemoryModels() {
  const data = await request('/api/memory/models');
  return Array.isArray(data) ? data : [];
}

/** @param {string} model @param {string} content @returns {Promise<Fact>} */
export function addFact(model, content) {
  return request('/api/memory', jsonInit('POST', { model, content }));
}

/** @param {string} id @param {string} content @returns {Promise<Fact>} */
export function updateFact(id, content) {
  return request(`/api/memory/${encodeURIComponent(id)}`, jsonInit('PATCH', { content }));
}

/** @param {string} id @returns {Promise<void>} */
export async function deleteFact(id) {
  await request(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * @param {string} model
 * @param {{ enabled?: boolean, autoExtract?: boolean }} settings
 * @returns {Promise<MemorySettings>}
 */
export function setMemorySettings(model, settings) {
  return request('/api/memory/settings', jsonInit('PUT', { model, ...settings }));
}

/**
 * Mémoire à injecter en message système avant l'envoi. Silencieux : renvoie null en cas d'échec.
 * @param {string} model
 * @returns {Promise<string|null>}
 */
export async function getSystemMemory(model) {
  try {
    const data = await request(`/api/memory/system?model=${encodeURIComponent(model)}`);
    return data && typeof data.content === 'string' && data.content ? data.content : null;
  } catch (err) {
    console.warn(err);
    return null;
  }
}

/**
 * Propose 0 à 3 faits à partir d'un échange. Rien n'est enregistré.
 * Le serveur prépare l'invite, le moteur local génère, le serveur analyse le texte produit.
 * @param {{ model: string, messages: { role: 'user'|'assistant', content: string }[] }} input
 * @returns {Promise<string[]>}
 */
export async function extractFacts({ model, messages }) {
  // La mémoire est rangée par id de modèle (sans le préfixe `server::`) ; la génération garde le préfixe.
  const memoryModel = splitModel(model).id;
  const prompt = await request('/api/memory/extract-prompt', jsonInit('POST', { model: memoryModel, messages }));
  if (!prompt || prompt.skip) return [];
  const text = await generateText({ model, messages: prompt.messages, maxTokens: prompt.maxTokens });
  const data = await request('/api/memory/extract-parse', jsonInit('POST', { model: memoryModel, text }));
  return Array.isArray(data?.facts) ? data.facts : [];
}
