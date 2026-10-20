import type { APIRoute } from 'astro';
import { fetchUnread, getMailAccount, MailError, parseAccountId } from '../../../lib/server/mail';
import { json, sameOrigin } from '../../../lib/server/http';

export const GET: APIRoute = async ({ request, url }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const id = parseAccountId(url.searchParams.get('account'));
  if (id === null) return json({ error: 'Compte invalide' }, 400);
  const a = getMailAccount(id);
  if (!a) return json({ error: 'Compte introuvable' }, 404);
  if (!a.host || !a.user || !a.password)
    return json({ error: 'Compte incomplet : serveur, identifiant et mot de passe requis' }, 400);
  try {
    const emails = await fetchUnread(a);
    return json({ emails });
  } catch (e) {
    if (e instanceof MailError) return json({ error: e.message }, 502);
    // Jamais de détail brut (il pourrait citer la configuration) : seulement le type d'erreur.
    console.warn('[mail] erreur inattendue:', (e as Error)?.name);
    return json({ error: 'Erreur inattendue lors de la lecture des e-mails' }, 502);
  }
};
