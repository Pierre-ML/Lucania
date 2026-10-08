import type { APIRoute } from 'astro';
import { connectionExists } from '../../../lib/server/connections';
import { json, readJson, validMessage, validModel, validTitle } from '../../../lib/server/http';
import { deleteConversation, folderExists, getConversation, updateConversation } from '../../../lib/server/storage';

export const prerender = false;

const notFound = () => json({ error: 'Conversation introuvable' }, 404);

export const GET: APIRoute = async ({ params }) => {
  const c = await getConversation(params.id ?? '');
  return c ? json(c) : notFound();
};

export const PATCH: APIRoute = async ({ params, request }) => {
  const id = params.id ?? '';
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  const patch: {
    title?: string;
    model?: string;
    messages?: any[];
    folderId?: string | null;
    think?: boolean;
    pinned?: boolean;
    connectionId?: string | null;
  } = {};
  if (body.title !== undefined) {
    if (!validTitle(body.title)) return json({ error: 'Titre invalide' }, 400);
    patch.title = body.title.trim();
  }
  if (body.model !== undefined) {
    if (!validModel(body.model)) return json({ error: 'Modèle invalide' }, 400);
    patch.model = body.model.trim();
  }
  if (body.messages !== undefined) {
    if (!Array.isArray(body.messages) || !body.messages.every((m: any) => validMessage(m)))
      return json({ error: 'messages invalide' }, 400);
    patch.messages = body.messages.map((m: any) => ({
      role: m.role,
      content: m.content,
      ...(m.thinking !== undefined && { thinking: m.thinking }),
      model: m.model,
      createdAt: m.createdAt,
    }));
  }
  if (body.folderId !== undefined) {
    if (body.folderId !== null && !(await folderExists(body.folderId)))
      return json({ error: 'Dossier introuvable' }, 400);
    patch.folderId = body.folderId;
  }
  if (body.think !== undefined) {
    if (typeof body.think !== 'boolean') return json({ error: 'think invalide' }, 400);
    patch.think = body.think;
  }
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== 'boolean') return json({ error: 'pinned invalide' }, 400);
    patch.pinned = body.pinned;
  }
  if (body.connectionId !== undefined) {
    if (body.connectionId !== null && !connectionExists(body.connectionId))
      return json({ error: 'Connexion introuvable' }, 400);
    patch.connectionId = body.connectionId;
  }
  const c = await updateConversation(id, patch);
  return c ? json(c) : notFound();
};

export const DELETE: APIRoute = async ({ params }) => {
  const ok = await deleteConversation(params.id ?? '');
  return ok ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }) : notFound();
};
