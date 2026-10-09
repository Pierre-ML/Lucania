import type { APIRoute } from 'astro';
import { getLang } from '../../i18n';
import { getConnectionSecret } from '../../lib/server/connections';
import { json, readJson, validModel } from '../../lib/server/http';
import { buildMemorySystemMessage } from '../../lib/server/memory';

export const POST: APIRoute = async ({ request, cookies }) => {
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  const conn = getConnectionSecret(body.connectionId);
  if (!conn || !conn.enabled) return json({ error: 'Connexion inconnue ou désactivée' }, 400);
  if (!validModel(body.model)) return json({ error: 'Modèle invalide' }, 400);
  const model = body.model.trim();
  const { messages } = body;
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    !messages.every(
      (m: any) =>
        m && typeof m === 'object' && ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string',
    )
  ) {
    return json({ error: 'messages invalide' }, 400);
  }

  // Mémoire : les faits du modèle sont injectés en tête (sauf si le corps demande memory: false).
  const memoryText = body.memory === false ? null : buildMemorySystemMessage(model, getLang({ cookies, request }));
  const outMessages = [
    ...(memoryText ? [{ role: 'system', content: memoryText }] : []),
    ...messages.map(({ role, content }: any) => ({ role, content })),
  ];

  const send = (think: unknown) =>
    fetch(`${conn.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: outMessages,
        stream: true,
        ...(typeof think === 'boolean' && { think }),
      }),
      signal: request.signal,
    });

  let upstream: Response;
  try {
    upstream = await send(body.think);
    if (!upstream.ok && upstream.status === 400 && typeof body.think === 'boolean') {
      const text = await upstream.text().catch(() => '');
      if (/does not support thinking/i.test(text)) {
        upstream = await send(undefined);
      } else {
        return json({ error: text.trim() || `Erreur Ollama (HTTP ${upstream.status})` }, 502);
      }
    }
  } catch {
    return json({ error: 'Serveur injoignable' }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const text = (await upstream.text().catch(() => '')).trim();
    return json({ error: text || `Erreur Ollama (HTTP ${upstream.status})` }, 502);
  }
  return new Response(upstream.body, {
    headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' },
  });
};
