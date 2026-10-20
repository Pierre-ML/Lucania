import type { APIRoute } from 'astro';
import { deleteMailMemory, parseAccountId, parseMemoryContent, updateMailMemory } from '../../../../lib/server/mail';
import { json, readJson, sameOrigin } from '../../../../lib/server/http';

const notFound = () => json({ error: 'Entrée introuvable' }, 404);

export const PUT: APIRoute = async ({ params, request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const id = parseAccountId(params.id);
  if (id === null) return notFound();
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  const c = parseMemoryContent(body.content);
  if (!c.ok) return json({ error: c.error }, 400);
  const entry = updateMailMemory(id, c.value);
  return entry ? json(entry) : notFound();
};

export const DELETE: APIRoute = async ({ params, request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const id = parseAccountId(params.id);
  if (id === null || !deleteMailMemory(id)) return notFound();
  return json({ ok: true });
};
