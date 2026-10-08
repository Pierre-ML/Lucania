// Appels Ollama (via les routes /api/* du serveur).
import { t } from './i18n.js';

/**
 * @typedef {{ role: 'user'|'assistant', content: string }} ChatMessage
 * @typedef {{ content: string, thinking: string }} ChatResult
 */

/**
 * Sépare le raisonnement `<think>…</think>` de la réponse.
 * @param {string} raw
 * @returns {{ content: string, thinking: string }}
 */
export function splitThinking(raw) {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('<think>')) return { content: raw, thinking: '' };
  const rest = trimmed.slice('<think>'.length);
  const end = rest.indexOf('</think>');
  if (end === -1) return { content: '', thinking: rest };
  return {
    thinking: rest.slice(0, end),
    content: rest.slice(end + '</think>'.length).trimStart(),
  };
}

/**
 * Envoie la conversation et lit le flux NDJSON.
 * @param {{ connectionId: string, model: string, messages: ChatMessage[], signal?: AbortSignal, think?: boolean, onUpdate?: (r: ChatResult) => void }} opts
 * @returns {Promise<ChatResult>}
 */
export async function streamChat({ connectionId, model, messages, signal, think, onUpdate }) {
  const payload = { connectionId, model, messages };
  if (typeof think === 'boolean') payload.think = think;
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    let msg = t('chat.errors.http', { status: response.status });
    try {
      const data = await response.json();
      if (data && data.error) msg = String(data.error);
    } catch {
      /* corps non JSON */
    }
    throw new Error(msg);
  }
  if (!response.body) throw new Error(t('chat.errors.emptyResponse'));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let raw = '';
  let thinkingField = '';
  let finished = false;
  /** @type {ChatResult} */
  let result = { content: '', thinking: '' };

  /** @param {string} line */
  const handleLine = (line) => {
    if (!line.trim()) return;
    const data = JSON.parse(line);
    if (data.error) throw new Error(String(data.error));
    if (data.message) {
      if (typeof data.message.content === 'string') raw += data.message.content;
      if (typeof data.message.thinking === 'string') thinkingField += data.message.thinking;
    }
    const split = splitThinking(raw);
    result = { content: split.content, thinking: thinkingField + split.thinking };
    if (onUpdate) onUpdate(result);
    if (data.done) finished = true;
  };

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while (!finished && (nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(line);
      }
    }
    if (!finished) {
      buffer += decoder.decode();
      handleLine(buffer);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return result;
}
