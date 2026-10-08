import type { APIRoute } from 'astro';
import { createConnection, listConnections, parseConnectionInput } from '../../../lib/server/connections';
import { json, readJson, sameOrigin } from '../../../lib/server/http';

export const GET: APIRoute = async () => json(listConnections());

export const POST: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  const p = parseConnectionInput(body, true);
  if (!p.ok) return json({ error: p.error }, 400);
  return json(createConnection(p.value), 201);
};
