import type { APIRoute } from 'astro';
import { getLang } from '../../../i18n';
import { json, readJson, sameOrigin, validModel } from '../../../lib/server/http';
import { buildExtractionMessages } from '../../../lib/server/memory';

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  if (!validModel(body.model)) return json({ error: 'Modèle invalide' }, 400);
  const { messages } = body;
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > 20 ||
    !messages.every(
      (m: any) => m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
    )
  ) {
    return json({ error: 'messages invalide' }, 400);
  }
  return json(
    buildExtractionMessages({
      model: body.model.trim(),
      messages: messages.map(({ role, content }: any) => ({ role, content })),
      lang: getLang({ cookies, request }),
    }),
  );
};
