import type { APIRoute } from 'astro';
import { dataDirPath } from '../../lib/server/db';
import { json } from '../../lib/server/http';

export const GET: APIRoute = async () =>
  json({
    desktop: process.env.LUCANIA_DESKTOP === '1',
    dataDir: dataDirPath(),
    appVersion: import.meta.env.LUCANIA_VERSION,
  });
