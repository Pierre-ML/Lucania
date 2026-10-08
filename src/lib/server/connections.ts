// Connexions = serveurs Ollama configurés (table `connections`). Serveur uniquement.
// Le jeton d'extinction n'est JAMAIS renvoyé au client : seul `hasToken` est exposé.
import crypto from 'node:crypto';
import { getDb, withTransaction } from './db';
import { isValidId } from './storage';

export type ConnectionKind = 'local' | 'remote';
export type ShutdownMethod = 'GET' | 'POST';

export interface Connection {
  id: string;
  name: string;
  kind: ConnectionKind;
  baseUrl: string;
  enabled: boolean;
  autoModels: boolean;
  manualModels: string[];
  shutdown: { enabled: boolean; url: string; method: ShutdownMethod; hasToken: boolean };
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** Vue interne (serveur) incluant le jeton : ne jamais sérialiser vers le client. */
export interface ConnectionSecret extends Connection {
  shutdownToken: string;
}

interface ConnRow {
  id: string;
  name: string;
  kind: ConnectionKind;
  base_url: string;
  enabled: number;
  auto_models: number;
  manual_models: string;
  shutdown_enabled: number;
  shutdown_url: string;
  shutdown_method: string;
  shutdown_token: string;
  position: number;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT id, name, kind, base_url, enabled, auto_models, manual_models, shutdown_enabled,
  shutdown_url, shutdown_method, shutdown_token, position, created_at, updated_at FROM connections`;

function parseModels(s: string): string[] {
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.filter((m): m is string => typeof m === 'string') : [];
  } catch {
    return [];
  }
}

function toSecret(r: ConnRow): ConnectionSecret {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind === 'remote' ? 'remote' : 'local',
    baseUrl: r.base_url,
    enabled: Number(r.enabled) !== 0,
    autoModels: Number(r.auto_models) !== 0,
    manualModels: parseModels(r.manual_models),
    shutdown: {
      enabled: Number(r.shutdown_enabled) !== 0,
      url: r.shutdown_url,
      method: r.shutdown_method === 'POST' ? 'POST' : 'GET',
      hasToken: r.shutdown_token !== '',
    },
    position: Number(r.position),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    shutdownToken: r.shutdown_token,
  };
}

/** Retire le jeton : forme publique conforme au contrat. */
export function publicConnection(c: ConnectionSecret): Connection {
  const { shutdownToken: _t, ...pub } = c;
  return { ...pub, shutdown: { ...pub.shutdown }, manualModels: [...pub.manualModels] };
}

export function listConnectionsSecret(): ConnectionSecret[] {
  const rows = getDb()
    .prepare(`${SELECT} ORDER BY position ASC, created_at ASC, rowid ASC`)
    .all() as unknown as ConnRow[];
  return rows.map(toSecret);
}

export function listConnections(): Connection[] {
  return listConnectionsSecret().map(publicConnection);
}

export function getConnectionSecret(id: unknown): ConnectionSecret | null {
  if (!isValidId(id)) return null;
  const r = getDb().prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as ConnRow | undefined;
  return r ? toSecret(r) : null;
}

export function getConnection(id: unknown): Connection | null {
  const c = getConnectionSecret(id);
  return c ? publicConnection(c) : null;
}

export function connectionExists(id: unknown): boolean {
  if (!isValidId(id)) return false;
  return !!getDb().prepare('SELECT 1 AS x FROM connections WHERE id = ?').get(id);
}

// ---- Validation ----

/** URL http(s) valide, trim, sans slash final ; null sinon. */
export function normalizeHttpUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\/+$/, '');
  if (!s || s.length > 500) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
  } catch {
    return null;
  }
  return s;
}

export interface ConnectionChanges {
  name?: string;
  kind?: ConnectionKind;
  baseUrl?: string;
  enabled?: boolean;
  autoModels?: boolean;
  manualModels?: string[];
  shutdownEnabled?: boolean;
  shutdownUrl?: string;
  shutdownMethod?: ShutdownMethod;
  shutdownToken?: string;
}

/** Valide un ConnectionInput (POST si `creating`, PATCH sinon). */
export function parseConnectionInput(
  body: any,
  creating: boolean,
): { ok: true; value: ConnectionChanges } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  const v: ConnectionChanges = {};

  if (creating) {
    if (body.name === undefined) return fail('Nom requis');
    if (body.kind === undefined) return fail('Type de connexion requis');
    if (body.baseUrl === undefined) return fail('Adresse du serveur requise');
  }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.trim().length > 60)
      return fail('Nom invalide (1 à 60 caractères)');
    v.name = body.name.trim();
  }
  if (body.kind !== undefined) {
    if (body.kind !== 'local' && body.kind !== 'remote') return fail('Type invalide (local ou remote)');
    v.kind = body.kind;
  }
  if (body.baseUrl !== undefined) {
    const u = normalizeHttpUrl(body.baseUrl);
    if (!u) return fail('Adresse du serveur invalide (URL http:// ou https://)');
    v.baseUrl = u;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return fail('enabled invalide');
    v.enabled = body.enabled;
  }
  if (body.autoModels !== undefined) {
    if (typeof body.autoModels !== 'boolean') return fail('autoModels invalide');
    v.autoModels = body.autoModels;
  }
  if (body.manualModels !== undefined) {
    const a = body.manualModels;
    if (!Array.isArray(a)) return fail('manualModels invalide (liste attendue)');
    if (a.length > 50) return fail('Trop de modèles manuels (50 au maximum)');
    const out: string[] = [];
    for (const m of a) {
      if (typeof m !== 'string' || m.trim().length < 1 || m.trim().length > 200)
        return fail('Nom de modèle invalide (1 à 200 caractères)');
      const t = m.trim();
      if (out.includes(t)) return fail(`Modèle en double : ${t}`);
      out.push(t);
    }
    v.manualModels = out;
  }
  if (body.shutdown !== undefined) {
    const s = body.shutdown;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return fail('shutdown invalide');
    if (s.enabled !== undefined) {
      if (typeof s.enabled !== 'boolean') return fail('shutdown.enabled invalide');
      v.shutdownEnabled = s.enabled;
    }
    if (s.url !== undefined) {
      if (typeof s.url !== 'string') return fail("URL d'extinction invalide");
      if (s.url.trim() === '') v.shutdownUrl = '';
      else {
        const u = normalizeHttpUrl(s.url);
        if (!u) return fail("URL d'extinction invalide (URL http:// ou https://)");
        v.shutdownUrl = u;
      }
    }
    if (s.method !== undefined) {
      const m = typeof s.method === 'string' ? s.method.trim().toUpperCase() : '';
      if (m !== 'GET' && m !== 'POST') return fail('Méthode d’extinction invalide (GET ou POST)');
      v.shutdownMethod = m;
    }
    if (s.token !== undefined) {
      if (typeof s.token !== 'string' || s.token.length > 1000) return fail("Jeton d'extinction invalide");
      v.shutdownToken = s.token.trim();
    }
  }
  return { ok: true, value: v };
}

// ---- Écriture ----

export function createConnection(v: ConnectionChanges): Connection {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  withTransaction((db) => {
    const max = db.prepare('SELECT MAX(position) AS m FROM connections').get() as unknown as { m: number | null };
    const position = max.m === null || max.m === undefined ? 0 : Number(max.m) + 1;
    db.prepare(
      `INSERT INTO connections (id, name, kind, base_url, enabled, auto_models, manual_models,
         shutdown_enabled, shutdown_url, shutdown_method, shutdown_token, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      v.name!,
      v.kind!,
      v.baseUrl!,
      v.enabled === false ? 0 : 1,
      v.autoModels === false ? 0 : 1,
      JSON.stringify(v.manualModels ?? []),
      v.shutdownEnabled ? 1 : 0,
      v.shutdownUrl ?? '',
      v.shutdownMethod ?? 'GET',
      v.shutdownToken ?? '',
      position,
      now,
      now,
    );
  });
  return getConnection(id)!;
}

export function updateConnection(id: string, v: ConnectionChanges): Connection | null {
  if (!isValidId(id)) return null;
  const found = withTransaction((db) => {
    const cur = getConnectionSecret(id);
    if (!cur) return false;
    db.prepare(
      `UPDATE connections SET name = ?, kind = ?, base_url = ?, enabled = ?, auto_models = ?, manual_models = ?,
         shutdown_enabled = ?, shutdown_url = ?, shutdown_method = ?, shutdown_token = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      v.name ?? cur.name,
      v.kind ?? cur.kind,
      v.baseUrl ?? cur.baseUrl,
      (v.enabled ?? cur.enabled) ? 1 : 0,
      (v.autoModels ?? cur.autoModels) ? 1 : 0,
      JSON.stringify(v.manualModels ?? cur.manualModels),
      (v.shutdownEnabled ?? cur.shutdown.enabled) ? 1 : 0,
      v.shutdownUrl ?? cur.shutdown.url,
      v.shutdownMethod ?? cur.shutdown.method,
      v.shutdownToken ?? cur.shutdownToken,
      new Date().toISOString(),
      id,
    );
    return true;
  });
  return found ? getConnection(id) : null;
}

/** Supprime la connexion ; les conversations sont conservées (connection_id → NULL). */
export function deleteConnection(id: string): boolean {
  if (!isValidId(id)) return false;
  return withTransaction((db) => {
    db.prepare('UPDATE conversations SET connection_id = NULL WHERE connection_id = ?').run(id);
    const r = db.prepare('DELETE FROM connections WHERE id = ?').run(id);
    return Number(r.changes) > 0;
  });
}
