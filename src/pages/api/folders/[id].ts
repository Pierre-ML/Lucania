import type { APIRoute } from 'astro';
import { json, noContent, readJson, sameOrigin, validFolderName } from '../../../lib/server/http';
import { deleteFolder, isFolderColor, isFolderIcon, updateFolder } from '../../../lib/server/storage';

const notFound = () => json({ error: 'Dossier introuvable' }, 404);

export const PATCH: APIRoute = async ({ params, request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  const patch: { name?: string; color?: string; icon?: string } = {};
  if (body.name !== undefined) {
    if (!validFolderName(body.name)) return json({ error: 'Nom de dossier invalide (1 à 80 caractères)' }, 400);
    patch.name = body.name.trim();
  }
  if (body.color !== undefined) {
    if (!isFolderColor(body.color)) return json({ error: 'Couleur de dossier invalide' }, 400);
    patch.color = body.color;
  }
  if (body.icon !== undefined) {
    if (!isFolderIcon(body.icon)) return json({ error: 'Icône de dossier invalide' }, 400);
    patch.icon = body.icon;
  }
  if (Object.keys(patch).length === 0) return json({ error: 'Aucune modification fournie' }, 400);
  const f = await updateFolder(params.id ?? '', patch);
  return f ? json(f) : notFound();
};

export const DELETE: APIRoute = async ({ params }) => {
  const ok = await deleteFolder(params.id ?? '');
  return ok ? noContent() : notFound();
};
