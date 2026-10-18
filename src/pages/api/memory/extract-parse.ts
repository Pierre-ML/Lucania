import type { APIRoute } from 'astro';
import { json, readJson, sameOrigin, validModel } from '../../../lib/server/http';
import { parseExtractedFacts } from '../../../lib/server/memory';

export const POST: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  if (!validModel(body.model)) return json({ error: 'Modèle invalide' }, 400);
  if (typeof body.text !== 'string' || body.text.length > 20_000) return json({ error: 'text invalide' }, 400);
  return json({ facts: parseExtractedFacts(body.model.trim(), body.text) });
};
