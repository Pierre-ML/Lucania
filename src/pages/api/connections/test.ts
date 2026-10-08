import type { APIRoute } from 'astro';
import { normalizeHttpUrl } from '../../../lib/server/connections';
import { json, readJson, sameOrigin } from '../../../lib/server/http';
import { testBaseUrl } from '../../../lib/server/ollama';

// Teste une adresse avant enregistrement. Répond toujours 200 (sauf origine refusée).
export const POST: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  const baseUrl = normalizeHttpUrl(body?.baseUrl);
  if (!baseUrl) {
    return json({
      ok: false,
      latencyMs: null,
      models: [],
      version: null,
      error: 'Adresse invalide (URL http:// ou https://)',
    });
  }
  return json(await testBaseUrl(baseUrl));
};
