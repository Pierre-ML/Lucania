import type { APIRoute } from 'astro';
import {
  deleteMailAccount,
  getMailAccount,
  parseAccountId,
  parseMailAccountInput,
  publicMailAccount,
  updateMailAccount,
} from '../../../../lib/server/mail';
import { json, readJson, sameOrigin } from '../../../../lib/server/http';

const notFound = () => json({ error: 'Compte introuvable' }, 404);

export const PUT: APIRoute = async ({ params, request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const id = parseAccountId(params.id);
  if (id === null) return notFound();
  const cur = getMailAccount(id);
  if (!cur) return notFound();
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  const p = parseMailAccountInput(body, cur);
  if (!p.ok) return json({ error: p.error }, 400);
  const r = updateMailAccount(id, p.value);
  if (!r.ok) return json({ error: r.error }, r.status);
  return json(publicMailAccount(r.account));
};

export const DELETE: APIRoute = async ({ params, request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const id = parseAccountId(params.id);
  if (id === null || !deleteMailAccount(id)) return notFound();
  return json({ ok: true });
};
