import type { APIRoute } from 'astro';
import { json, readJson, sameOrigin, validModel } from '../../../lib/server/http';
import { setMemorySettings } from '../../../lib/server/memory';

export const PUT: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  if (!validModel(body.model)) return json({ error: 'Modèle invalide' }, 400);
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return json({ error: 'enabled invalide' }, 400);
  if (body.autoExtract !== undefined && typeof body.autoExtract !== 'boolean')
    return json({ error: 'autoExtract invalide' }, 400);
  return json(setMemorySettings(body.model.trim(), { enabled: body.enabled, autoExtract: body.autoExtract }));
};
