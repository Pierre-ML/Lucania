import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { dataDirPath } from '../../lib/server/db';
import { json } from '../../lib/server/http';

function appVersion(): string {
  const v = process.env.LUCANIA_VERSION?.trim();
  if (v) return v;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    if (typeof pkg?.version === 'string' && pkg.version) return pkg.version;
  } catch {}
  return '0.1.0';
}

export const GET: APIRoute = async () =>
  json({
    desktop: process.env.LUCANIA_DESKTOP === '1',
    dataDir: dataDirPath(),
    appVersion: appVersion(),
  });
