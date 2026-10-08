import type { APIRoute } from 'astro';
import { getConnectionSecret } from '../../lib/server/connections';
import { json, readJson, sameOrigin } from '../../lib/server/http';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ ok: false, error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  if (!body || body.confirm !== true) return json({ ok: false, error: 'Confirmation requise' }, 400);
  const conn = getConnectionSecret(body.connectionId);
  if (!conn) return json({ ok: false, error: 'Connexion introuvable' }, 400);
  if (!conn.shutdown.enabled || !conn.shutdown.url) {
    return json({ ok: false, error: "L'extinction n'est pas activée pour cette connexion" }, 400);
  }

  const token = conn.shutdownToken;
  if (!token || token === 'CHANGE_ME') {
    return json({ ok: false, error: "Jeton d'extinction non configuré pour cette connexion" }, 500);
  }
  let target: URL;
  try {
    target = new URL(conn.shutdown.url);
    target.searchParams.set('token', token);
  } catch {
    return json({ ok: false, error: "URL d'extinction invalide" }, 500);
  }
  try {
    const r = await fetch(target, { method: conn.shutdown.method, signal: AbortSignal.timeout(8000) });
    await r.body?.cancel().catch(() => {});
    if (r.ok) return json({ ok: true });
    return json({ ok: false, error: `Le listener d'extinction a répondu HTTP ${r.status}` }, 502);
  } catch {
    // Message générique : l'erreur de fetch peut contenir l'URL (donc le token).
    return json({ ok: false, error: "Listener d'extinction injoignable" }, 502);
  }
};
