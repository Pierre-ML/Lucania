import type { APIRoute } from 'astro';
import { getMailAccount, getMailMarkSeen, MailError, markSeen } from '../../../lib/server/mail';
import { json, readJson, sameOrigin } from '../../../lib/server/http';

const MAX_UIDS = 5000;

// Marque des e-mails comme lus (drapeau \Seen uniquement). Refusé tant que l'option n'est pas activée.
export const POST: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);

  const { account, uids } = body;
  if (typeof account !== 'number' || !Number.isInteger(account) || account <= 0)
    return json({ error: 'Compte invalide' }, 400);
  if (
    !Array.isArray(uids) ||
    uids.length < 1 ||
    uids.length > MAX_UIDS ||
    !uids.every((n) => typeof n === 'number' && Number.isInteger(n) && n > 0)
  )
    return json({ error: `Liste d’e-mails invalide (1 à ${MAX_UIDS} identifiants entiers positifs)` }, 400);

  const a = getMailAccount(account);
  if (!a) return json({ error: 'Compte introuvable' }, 404);
  if (!getMailMarkSeen()) return json({ error: 'Option « marquer comme lus » désactivée' }, 403);
  if (!a.host || !a.user || !a.password)
    return json({ error: 'Compte incomplet : serveur, identifiant et mot de passe requis' }, 400);

  try {
    const count = await markSeen(a, [...new Set<number>(uids)]);
    return json({ ok: true, count });
  } catch (e) {
    if (e instanceof MailError) return json({ error: e.message }, 502);
    console.warn('[mail] erreur inattendue:', (e as Error)?.name);
    return json({ error: 'Erreur inattendue lors du marquage des e-mails' }, 502);
  }
};
