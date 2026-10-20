import type { APIRoute } from 'astro';
import {
  clearProcessed,
  listProcessed,
  parseAccountId,
  parseProcessedInput,
  parseProcessedPatch,
  processedUids,
  saveProcessed,
  updateProcessed,
} from '../../../lib/server/mail';
import { json, readJson, sameOrigin } from '../../../lib/server/http';

export const GET: APIRoute = async ({ url }) => {
  // ?account=ID : uniquement les UID déjà traités de ce compte (pour ne pas les renvoyer à l'IA).
  const acc = url.searchParams.get('account');
  if (acc !== null) {
    const id = parseAccountId(acc);
    if (id === null) return json({ error: 'Compte invalide' }, 400);
    return json({ uids: processedUids(id) });
  }
  const raw = Number(url.searchParams.get('limit') ?? 500);
  const limit = Number.isInteger(raw) ? Math.min(2000, Math.max(1, raw)) : 500;
  return json({ items: listProcessed(limit) });
};

export const POST: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  const p = parseProcessedInput(body);
  if (!p.ok) return json({ error: p.error }, 400);
  saveProcessed(p.value);
  return json({ ok: true });
};

export const PATCH: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  const p = parseProcessedPatch(body);
  if (!p.ok) return json({ error: p.error }, 400);
  const { accountId, uid, ...changes } = p.value;
  if (!updateProcessed(accountId, uid, changes)) return json({ error: 'E-mail introuvable dans l’historique' }, 404);
  return json({ ok: true });
};

export const DELETE: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  clearProcessed();
  return json({ ok: true });
};
