import type { APIRoute } from 'astro';
import { json, readJson, validFolderName } from '../../../lib/server/http';
import { createFolder, listFolders } from '../../../lib/server/storage';

export const GET: APIRoute = async () => json(await listFolders());

export const POST: APIRoute = async ({ request }) => {
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  if (!validFolderName(body.name)) return json({ error: 'Nom de dossier invalide (1 à 80 caractères)' }, 400);
  return json(await createFolder(body.name.trim()), 201);
};
