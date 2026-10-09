import type { APIRoute } from 'astro';
import { json, noContent, readJson, sameOrigin } from '../../../lib/server/http';
import { deleteFact, parseFactContent, updateFact } from '../../../lib/server/memory';
import { isValidId } from '../../../lib/server/storage';

const notFound = () => json({ error: 'Fait introuvable' }, 404);

export const PATCH: APIRoute = async ({ params, request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  const content = parseFactContent(body.content);
  if (content === null) return json({ error: 'Contenu invalide (1 à 500 caractères)' }, 400);
  const id = params.id ?? '';
  const fact = isValidId(id) ? updateFact(id, content) : null;
  return fact ? json(fact) : notFound();
};

export const DELETE: APIRoute = async ({ params, request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const id = params.id ?? '';
  return isValidId(id) && deleteFact(id) ? noContent() : notFound();
};
