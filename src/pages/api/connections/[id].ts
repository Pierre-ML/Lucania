import type { APIRoute } from 'astro';
import {
  deleteConnection,
  getConnection,
  parseConnectionInput,
  updateConnection,
} from '../../../lib/server/connections';
import { json, noContent, readJson, sameOrigin } from '../../../lib/server/http';
import { invalidateProbe } from '../../../lib/server/ollama';

export const prerender = false;

const notFound = () => json({ error: 'Connexion introuvable' }, 404);

export const GET: APIRoute = async ({ params }) => {
  const c = getConnection(params.id ?? '');
  return c ? json(c) : notFound();
};

export const PATCH: APIRoute = async ({ params, request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  const p = parseConnectionInput(body, false);
  if (!p.ok) return json({ error: p.error }, 400);
  const id = params.id ?? '';
  const c = updateConnection(id, p.value);
  if (!c) return notFound();
  invalidateProbe(id);
  return json(c);
};

export const DELETE: APIRoute = async ({ params, request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const id = params.id ?? '';
  if (!deleteConnection(id)) return notFound();
  invalidateProbe(id);
  return noContent();
};
