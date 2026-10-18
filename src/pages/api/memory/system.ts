import type { APIRoute } from 'astro';
import { getLang } from '../../../i18n';
import { json, validModel } from '../../../lib/server/http';
import { buildMemorySystemMessage } from '../../../lib/server/memory';

export const GET: APIRoute = async ({ url, cookies, request }) => {
  const model = url.searchParams.get('model');
  if (!validModel(model)) return json({ error: 'Modèle invalide' }, 400);
  return json({ content: buildMemorySystemMessage(model.trim(), getLang({ cookies, request })) });
};
