import type { APIRoute } from 'astro';
import { deleteConnection, parseConnectionInput, updateConnection } from '../../../lib/server/connections';
import { json, noContent, readJson, sameOrigin } from '../../../lib/server/http';

const notFound = () => json({ error: 'Connexion introuvable' }, 404);

export const PATCH: APIRoute = async ({ params, request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  const p = parseConnectionInput(body, false);
  if (!p.ok) return json({ error: p.error }, 400);
  const id = params.id ?? '';
  const c = updateConnection(id, p.value);
  if (!c) return notFound();
  return json(c);
};

export const DELETE: APIRoute = async ({ params, request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const id = params.id ?? '';
  if (!deleteConnection(id)) return notFound();
  return noContent();
};
