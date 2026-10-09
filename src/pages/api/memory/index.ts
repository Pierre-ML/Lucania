import type { APIRoute } from 'astro';
import { json, readJson, sameOrigin, validModel } from '../../../lib/server/http';
import { createFact, getMemorySettings, listFacts, parseFactContent } from '../../../lib/server/memory';

export const GET: APIRoute = async ({ url }) => {
  const model = url.searchParams.get('model');
  if (!validModel(model)) return json({ error: 'Modèle invalide' }, 400);
  const m = model.trim();
  const { enabled, autoExtract } = getMemorySettings(m);
  return json({ model: m, enabled, autoExtract, facts: listFacts(m) });
};

export const POST: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  if (!validModel(body.model)) return json({ error: 'Modèle invalide' }, 400);
  const content = parseFactContent(body.content);
  if (content === null) return json({ error: 'Contenu invalide (1 à 500 caractères)' }, 400);
  return json(createFact(body.model.trim(), content), 201);
};
