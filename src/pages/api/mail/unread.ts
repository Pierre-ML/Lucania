import type { APIRoute } from 'astro';
import { fetchUnread, getMailSettingsSecret, MailError } from '../../../lib/server/mail';
import { json, sameOrigin } from '../../../lib/server/http';

export const GET: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const s = getMailSettingsSecret();
  if (!s.host || !s.user || !s.password)
    return json({ error: 'Réglages e-mail incomplets : serveur, identifiant et mot de passe requis' }, 400);
  try {
    const emails = await fetchUnread(s);
    return json({ emails });
  } catch (e) {
    if (e instanceof MailError) return json({ error: e.message }, 502);
    // Jamais de détail brut (il pourrait citer la configuration) : seulement le type d'erreur.
    console.warn('[mail] erreur inattendue:', (e as Error)?.name);
    return json({ error: 'Erreur inattendue lors de la lecture des e-mails' }, 502);
  }
};
