import type { APIRoute } from 'astro';
import { createMailMemory, listMailMemory, parseMemoryContent } from '../../../../lib/server/mail';
import { json, readJson, sameOrigin } from '../../../../lib/server/http';

export const GET: APIRoute = async () => json({ entries: listMailMemory() });

export const POST: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  const c = parseMemoryContent(body.content);
  if (!c.ok) return json({ error: c.error }, 400);
  const r = createMailMemory(c.value);
  if (!r.ok) return json({ error: r.error }, 400);
  return json(r.entry, 201);
};
