import type { APIRoute } from 'astro';
import { addMailFeedback, listMailFeedback, parseMailFeedbackInput } from '../../../lib/server/mail';
import { json, readJson, sameOrigin } from '../../../lib/server/http';

export const GET: APIRoute = async ({ url }) => {
  const raw = Number(url.searchParams.get('limit') ?? 20);
  const limit = Number.isInteger(raw) ? Math.min(50, Math.max(1, raw)) : 20;
  return json({ items: listMailFeedback(limit) });
};

export const POST: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  const p = parseMailFeedbackInput(body);
  if (!p.ok) return json({ error: p.error }, 400);
  return json({ ok: true, memory: addMailFeedback(p.value) });
};
