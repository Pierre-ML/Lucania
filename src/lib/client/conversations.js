// Client des routes /api/conversations.
import { t } from './i18n.js';

/**
 * @typedef {{ role: 'user'|'assistant', content: string, thinking?: string, model: string, createdAt: string }} Message
 * @typedef {{ id: string, title: string, model: string, connectionId: string|null, createdAt: string, updatedAt: string, folderId: string|null, think: boolean, pinned: boolean, messages: Message[] }} Conversation
 * @typedef {{ id: string, title: string, model: string, connectionId: string|null, createdAt: string, updatedAt: string, folderId: string|null, think: boolean, pinned: boolean, messageCount: number }} ConversationSummary
 * @typedef {{ id: string, name: string, createdAt: string, updatedAt: string, conversationCount: number }} Folder
 */

/**
 * @param {string} url
 * @param {RequestInit} [init]
 */
async function request(url, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, { ...init, headers });
  if (!r.ok) {
    let msg = t('chat.errors.http', { status: r.status });
    try {
      const d = await r.json();
      if (d && d.error) msg = String(d.error);
    } catch {
      /* corps non JSON */
    }
    throw new Error(msg);
  }
  if (r.status === 204) return null;
  return r.json();
}

/** @returns {Promise<ConversationSummary[]>} */
export function listConversations() {
  return request('/api/conversations');
}

/** @param {string} id @returns {Promise<Conversation>} */
export function getConversation(id) {
  return request(`/api/conversations/${encodeURIComponent(id)}`);
}

/** @param {{ connectionId: string, model: string, title?: string, folderId?: string|null, think?: boolean }} data @returns {Promise<Conversation>} */
export function createConversation({ connectionId, model, title, folderId, think }) {
  return request('/api/conversations', { method: 'POST', body: JSON.stringify({ connectionId, model, title, folderId, think }) });
}

/**
 * @param {string} id
 * @param {{ title?: string, model?: string, connectionId?: string|null, messages?: Message[], folderId?: string|null, think?: boolean, pinned?: boolean }} patch
 * @returns {Promise<Conversation>}
 */
export function updateConversation(id, patch) {
  return request(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/** @param {string} id @returns {Promise<void>} */
export async function deleteConversation(id) {
  await request(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Mémorise le réglage « Réflexion » de la conversation. @param {string} id @param {boolean} think @returns {Promise<Conversation>} */
export function setConversationThink(id, think) {
  return updateConversation(id, { think });
}

/** Épingle ou désépingle la conversation. @param {string} id @param {boolean} pinned @returns {Promise<Conversation>} */
export function setConversationPinned(id, pinned) {
  return updateConversation(id, { pinned });
}

/* ---------- Dossiers ---------- */

/** @param {string} id @param {string|null} folderId @returns {Promise<Conversation>} */
export function moveConversation(id, folderId) {
  return updateConversation(id, { folderId });
}

/** @returns {Promise<Folder[]>} */
export function listFolders() {
  return request('/api/folders');
}

/** @param {string} name @returns {Promise<Folder>} */
export function createFolder(name) {
  return request('/api/folders', { method: 'POST', body: JSON.stringify({ name }) });
}

/** @param {string} id @param {string} name @returns {Promise<Folder>} */
export function renameFolder(id, name) {
  return request(`/api/folders/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
}

/** Supprime le dossier ; ses conversations sont conservées (folderId repasse à null). @param {string} id @returns {Promise<void>} */
export async function deleteFolder(id) {
  await request(`/api/folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
