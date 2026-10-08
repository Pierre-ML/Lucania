import type { APIRoute } from 'astro';
import { getConnectionSecret } from '../../../../lib/server/connections';
import { json, sameOrigin } from '../../../../lib/server/http';
import { rememberProbe, testBaseUrl } from '../../../../lib/server/ollama';

// Teste une connexion enregistrée. Répond toujours 200 (sauf origine refusée).
export const POST: APIRoute = async ({ params, request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const c = getConnectionSecret(params.id ?? '');
  if (!c) return json({ ok: false, latencyMs: null, models: [], version: null, error: 'Connexion introuvable' });
  const r = await testBaseUrl(c.baseUrl);
  const { version: _v, ...probe } = r;
  rememberProbe(c.id, c.baseUrl, probe);
  return json(r);
};
