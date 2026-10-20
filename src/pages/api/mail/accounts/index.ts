import type { APIRoute } from 'astro';
import {
  createMailAccount,
  listMailAccounts,
  parseMailAccountInput,
  publicMailAccount,
} from '../../../../lib/server/mail';
import { json, readJson, sameOrigin } from '../../../../lib/server/http';

// Le mot de passe n'est jamais renvoyé : seul `hasPassword` est exposé.
export const GET: APIRoute = async () => json({ accounts: listMailAccounts().map(publicMailAccount) });

export const POST: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  const p = parseMailAccountInput(body, null);
  if (!p.ok) return json({ error: p.error }, 400);
  const r = createMailAccount(p.value);
  if (!r.ok) return json({ error: r.error }, r.status);
  return json(publicMailAccount(r.account), 201);
};
