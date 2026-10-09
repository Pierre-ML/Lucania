import type { APIRoute } from 'astro';
import { connectionExists } from '../../../lib/server/connections';
import { json, readJson, validModel, validTitle } from '../../../lib/server/http';
import { createConversation, folderExists, listConversations } from '../../../lib/server/storage';

export const GET: APIRoute = async () => json(await listConversations());

export const POST: APIRoute = async ({ request }) => {
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  if (!validModel(body.model)) return json({ error: 'Modèle invalide' }, 400);
  if (body.title !== undefined && !validTitle(body.title)) return json({ error: 'Titre invalide' }, 400);
  let folderId: string | null = null;
  if (body.folderId !== undefined && body.folderId !== null) {
    if (!(await folderExists(body.folderId))) return json({ error: 'Dossier introuvable' }, 400);
    folderId = body.folderId;
  }
  let connectionId: string | null = null;
  if (body.connectionId !== undefined && body.connectionId !== null) {
    if (!connectionExists(body.connectionId)) return json({ error: 'Connexion introuvable' }, 400);
    connectionId = body.connectionId;
  }
  if (body.think !== undefined && typeof body.think !== 'boolean') return json({ error: 'think invalide' }, 400);
  if (body.useMemory !== undefined && typeof body.useMemory !== 'boolean')
    return json({ error: 'useMemory invalide' }, 400);
  if (body.learnMemory !== undefined && typeof body.learnMemory !== 'boolean')
    return json({ error: 'learnMemory invalide' }, 400);
  const conv = await createConversation({
    model: body.model.trim(),
    title: body.title?.trim(),
    folderId,
    think: body.think,
    useMemory: body.useMemory,
    learnMemory: body.learnMemory,
    connectionId,
  });
  return json(conv, 201);
};
