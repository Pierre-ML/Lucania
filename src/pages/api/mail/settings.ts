import type { APIRoute } from 'astro';
import {
  getMailSettingsSecret,
  parseMailSettingsInput,
  publicMailSettings,
  saveMailSettings,
} from '../../../lib/server/mail';
import { json, readJson, sameOrigin } from '../../../lib/server/http';

// Le mot de passe n'est jamais renvoyé : seul `hasPassword` est exposé.
export const GET: APIRoute = async () => json(publicMailSettings(getMailSettingsSecret()));

export const PUT: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ error: 'Origine refusée' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: 'Corps JSON invalide' }, 400);
  const p = parseMailSettingsInput(body, getMailSettingsSecret());
  if (!p.ok) return json({ error: p.error }, 400);
  return json(publicMailSettings(saveMailSettings(p.value)));
};
