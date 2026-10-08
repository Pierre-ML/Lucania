import type { APIRoute } from 'astro';
import { json, noContent, readJson, validFolderName } from '../../../lib/server/http';
import { deleteFolder, renameFolder } from '../../../lib/server/storage';

const notFound = () => json({ error: 'Dossier introuvable' }, 404);

export const PATCH: APIRoute = async ({ params, request }) => {
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  if (!validFolderName(body.name)) return json({ error: 'Nom de dossier invalide (1 à 80 caractères)' }, 400);
  const f = await renameFolder(params.id ?? '', body.name.trim());
  return f ? json(f) : notFound();
};

export const DELETE: APIRoute = async ({ params }) => {
  const ok = await deleteFolder(params.id ?? '');
  return ok ? noContent() : notFound();
};
