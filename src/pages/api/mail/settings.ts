import type { APIRoute } from 'astro';
import {
  getMailModel,
  getMailSystemPrompt,
  parseSystemPrompt,
  saveMailModel,
  saveMailSystemPrompt,
} from '../../../lib/server/mail';
import { json, readJson, sameOrigin, validModel } from '../../../lib/server/http';

// Réglages e-mail = modèle et prompt système. Les comptes IMAP vivent dans /api/mail/accounts.
export const GET: APIRoute = async () => json({ model: getMailModel(), systemPrompt: getMailSystemPrompt() });

export const PUT: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  if (body.model === undefined && body.systemPrompt === undefined) {
    return json({ error: 'Aucun réglage fourni' }, 400);
  }
  let model: string | null = null;
  if (body.model !== undefined) {
    if (typeof body.model !== 'string') return json({ error: 'Modèle invalide' }, 400);
    model = body.model.trim();
    if (model !== '' && !validModel(model)) return json({ error: 'Modèle invalide' }, 400);
  }
  let prompt: string | null = null;
  if (body.systemPrompt !== undefined) {
    const p = parseSystemPrompt(body.systemPrompt);
    if (!p.ok) return json({ error: p.error }, 400);
    prompt = p.value;
  }
  if (model !== null) saveMailModel(model);
  if (prompt !== null) saveMailSystemPrompt(prompt);
  return json({ model: getMailModel(), systemPrompt: getMailSystemPrompt() });
};
