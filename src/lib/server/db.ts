import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { envSeed } from './config';

const G = globalThis as unknown as { __iaDb?: DatabaseSync };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  thinking TEXT,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, position);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
`;

/** Dossier de données : LUCANIA_DATA_DIR (desktop) sinon ./data du projet. */
export const dataDirPath = (): string =>
  path.resolve(process.env.LUCANIA_DATA_DIR || path.join(process.cwd(), 'data'));

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);

function migrateJson(db: DatabaseSync) {
  const dir = path.join(dataDirPath(), 'conversations');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;

  const insConv = db.prepare(
    'INSERT OR IGNORE INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insMsg = db.prepare(
    'INSERT INTO messages (conversation_id, position, role, content, thinking, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  let count = 0;
  db.exec('BEGIN');
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!c || typeof c !== 'object' || !Array.isArray(c.messages)) throw new Error('format');
        const id = str(c.id, f.slice(0, -5));
        if (!ID_RE.test(id)) throw new Error('id invalide');
        const now = new Date().toISOString();
        const model = str(c.model, '');
        const created = str(c.createdAt, now);
        const r = insConv.run(id, str(c.title, 'Nouvelle conversation'), model, created, str(c.updatedAt, created));
        if (Number(r.changes) === 0) continue; // déjà présente
        c.messages.forEach((m: any, i: number) => {
          insMsg.run(
            id,
            i,
            m?.role === 'assistant' ? 'assistant' : 'user',
            str(m?.content, ''),
            typeof m?.thinking === 'string' ? m.thinking : null,
            str(m?.model, model),
            str(m?.createdAt, created),
          );
        });
        count++;
      } catch (e) {
        console.warn(`[db] migration: fichier ignoré (${f}): ${(e as Error).message}`);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.warn('[db] migration annulée:', (e as Error).message);
    return;
  }

  let target = `${dir}.migrated`;
  if (fs.existsSync(target)) target = `${target}-${Date.now()}`;
  try {
    fs.renameSync(dir, target);
    console.log(`[db] ${count} conversation(s) migrée(s), dossier renommé en ${path.basename(target)}`);
  } catch (e) {
    console.warn('[db] renommage du dossier impossible:', (e as Error).message);
  }
}

// v5 : connexions multiples (serveurs Ollama). Appelée dans la transaction de migrateSchema.
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  return cols.some((c) => c.name === column);
}

/** Exécute `fn` dans une transaction BEGIN IMMEDIATE (COMMIT, ou ROLLBACK si `fn` lève). */
export function withTransaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn(db);
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw e;
  }
}

function migrateV5(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('local','remote')),
    base_url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    auto_models INTEGER NOT NULL DEFAULT 1,
    manual_models TEXT NOT NULL DEFAULT '[]',
    shutdown_enabled INTEGER NOT NULL DEFAULT 0,
    shutdown_url TEXT NOT NULL DEFAULT '',
    shutdown_method TEXT NOT NULL DEFAULT 'GET',
    shutdown_token TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  if (!hasColumn(db, 'conversations', 'connection_id')) {
    db.exec('ALTER TABLE conversations ADD COLUMN connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_conv_connection ON conversations(connection_id)');

  const count = db.prepare('SELECT COUNT(*) AS n FROM connections').get() as unknown as { n: number };
  if (Number(count.n) > 0) return;

  // Connexion initiale : reprend l'ancienne configuration .env si elle existe.
  const e = envSeed();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const ins = db.prepare(
    `INSERT INTO connections (id, name, kind, base_url, enabled, auto_models, manual_models,
       shutdown_enabled, shutdown_url, shutdown_method, shutdown_token, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, 0, ?, ?)`,
  );
  if (e.ollamaUrl) {
    const models = [...new Set(e.ollamaModels.filter((m) => m.length <= 200))].slice(0, 50);
    const token = e.shutdownToken && e.shutdownToken !== 'CHANGE_ME' ? e.shutdownToken : '';
    ins.run(
      id,
      'Serveur distant (WireGuard)',
      'remote',
      e.ollamaUrl.replace(/\/+$/, ''),
      JSON.stringify(models),
      token ? 1 : 0,
      e.shutdownUrl.replace(/\/+$/, ''),
      e.shutdownMethod.toUpperCase() === 'POST' ? 'POST' : 'GET',
      token,
      now,
      now,
    );
  } else {
    ins.run(id, 'Ollama sur cet ordinateur', 'local', 'http://localhost:11434', '[]', 0, '', 'GET', '', now, now);
  }
  db.prepare('UPDATE conversations SET connection_id = ? WHERE connection_id IS NULL').run(id);
  console.log('[db] connexion initiale créée (schéma v5)');
}

function migrateSchema(db: DatabaseSync) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as
    | { value: string }
    | undefined;
  const version = Number(row?.value ?? '1');
  if (version >= 5) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (version < 2) {
      db.exec(`CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      if (!hasColumn(db, 'conversations', 'folder_id')) {
        db.exec('ALTER TABLE conversations ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL');
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_conv_folder ON conversations(folder_id)');
      db.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2')");
    }
    if (!hasColumn(db, 'conversations', 'think')) {
      db.exec('ALTER TABLE conversations ADD COLUMN think INTEGER NOT NULL DEFAULT 1');
    }
    db.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3')");
    if (!hasColumn(db, 'conversations', 'pinned')) {
      db.exec('ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    }
    db.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '4')");
    migrateV5(db);
    db.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '5')");
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw e;
  }
}

export function getDb(): DatabaseSync {
  if (G.__iaDb) {
    // Connexion conservée par le HMR de dev : s'assure que le schéma est à jour (idempotent).
    migrateSchema(G.__iaDb);
    return G.__iaDb;
  }
  const dataDir = dataDirPath();
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  migrateSchema(db);
  migrateJson(db);
  G.__iaDb = db;
  return db;
}
