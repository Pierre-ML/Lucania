import type { APIRoute } from 'astro';
import { getMailModel, saveMailModel } from '../../../lib/server/mail';
import { json, readJson, sameOrigin, validModel } from '../../../lib/server/http';

// Réglages e-mail = modèle seulement. Les comptes IMAP vivent dans /api/mail/accounts.
export const GET: APIRoute = async () => json({ model: getMailModel() });

export const PUT: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  if (typeof body.model !== 'string') return json({ error: 'Modèle invalide' }, 400);
  const model = body.model.trim();
  if (model !== '' && !validModel(model)) return json({ error: 'Modèle invalide' }, 400);
  return json({ model: saveMailModel(model) });
};
