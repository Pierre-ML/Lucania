import crypto from 'node:crypto';
import { getDb, withTransaction } from './db';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  model: string;
  createdAt: string;
}
export interface Conversation {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  folderId: string | null;
  think: boolean;
  useMemory: boolean;
  learnMemory: boolean;
  pinned: boolean;
  connectionId: string | null;
  messages: Message[];
}
export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  folderId: string | null;
  think: boolean;
  useMemory: boolean;
  learnMemory: boolean;
  pinned: boolean;
  connectionId: string | null;
  messageCount: number;
}
export interface Folder {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  conversationCount: number;
  color: string;
  icon: string;
}

/** Couleurs de dossier autorisées (jamais de rouge : réservé aux alertes). */
export const FOLDER_COLORS = ['default', 'sky', 'emerald', 'amber', 'violet', 'pink', 'orange', 'teal', 'slate'] as const;
/** Icônes de dossier autorisées. */
export const FOLDER_ICONS = [
  'folder', 'star', 'heart', 'code', 'book', 'briefcase', 'lightbulb', 'flask', 'music', 'image', 'globe', 'gamepad',
] as const;
export const isFolderColor = (v: unknown): v is string =>
  typeof v === 'string' && (FOLDER_COLORS as readonly string[]).includes(v);
export const isFolderIcon = (v: unknown): v is string =>
  typeof v === 'string' && (FOLDER_ICONS as readonly string[]).includes(v);

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const isValidId = (id: unknown): id is string => typeof id === 'string' && ID_RE.test(id);

interface ConvRow {
  id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
  folder_id: string | null;
  think: number;
  use_memory: number;
  learn_memory: number;
  pinned: number;
  connection_id: string | null;
}
interface MsgRow {
  role: 'user' | 'assistant';
  content: string;
  thinking: string | null;
  model: string;
  created_at: string;
}

function loadConversation(id: string): Conversation | null {
  if (!isValidId(id)) return null;
  const db = getDb();
  const c = db
    .prepare('SELECT id, title, model, created_at, updated_at, folder_id, think, use_memory, learn_memory, pinned, connection_id FROM conversations WHERE id = ?')
    .get(id) as unknown as ConvRow | undefined;
  if (!c) return null;
  const rows = db
    .prepare(
      'SELECT role, content, thinking, model, created_at FROM messages WHERE conversation_id = ? ORDER BY position ASC',
    )
    .all(id) as unknown as MsgRow[];
  return {
    id: c.id,
    title: c.title,
    model: c.model,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    folderId: c.folder_id ?? null,
    think: Number(c.think) !== 0,
    useMemory: Number(c.use_memory) !== 0,
    learnMemory: Number(c.learn_memory) !== 0,
    pinned: Number(c.pinned) !== 0,
    connectionId: c.connection_id ?? null,
    messages: rows.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.thinking !== null && { thinking: m.thinking }),
      model: m.model,
      createdAt: m.created_at,
    })),
  };
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.title, c.model, c.created_at, c.updated_at, c.folder_id, c.think, c.use_memory, c.learn_memory, c.pinned, c.connection_id,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c
       ORDER BY c.updated_at DESC`,
    )
    .all() as unknown as (ConvRow & { message_count: number })[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    model: r.model,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    folderId: r.folder_id ?? null,
    think: Number(r.think) !== 0,
    useMemory: Number(r.use_memory) !== 0,
    learnMemory: Number(r.learn_memory) !== 0,
    pinned: Number(r.pinned) !== 0,
    connectionId: r.connection_id ?? null,
    messageCount: Number(r.message_count),
  }));
}

export async function getConversation(id: string): Promise<Conversation | null> {
  return loadConversation(id);
}

export async function createConversation(input: {
  model: string;
  title?: string;
  folderId?: string | null;
  think?: boolean;
  useMemory?: boolean;
  learnMemory?: boolean;
  connectionId?: string | null;
}): Promise<Conversation> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const title = input.title ?? 'Nouvelle conversation';
  const folderId = input.folderId ?? null;
  const think = input.think ?? true;
  const useMemory = input.useMemory ?? true;
  const learnMemory = input.learnMemory ?? false;
  const connectionId = input.connectionId ?? null;
  getDb()
    .prepare(
      'INSERT INTO conversations (id, title, model, created_at, updated_at, folder_id, think, use_memory, learn_memory, connection_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, title, input.model, now, now, folderId, think ? 1 : 0, useMemory ? 1 : 0, learnMemory ? 1 : 0, connectionId);
  return {
    id,
    title,
    model: input.model,
    createdAt: now,
    updatedAt: now,
    folderId,
    think,
    useMemory,
    learnMemory,
    pinned: false,
    connectionId,
    messages: [],
  };
}

export async function updateConversation(
  id: string,
  patch: {
    title?: string;
    model?: string;
    messages?: Message[];
    folderId?: string | null;
    think?: boolean;
    useMemory?: boolean;
    learnMemory?: boolean;
    pinned?: boolean;
    connectionId?: string | null;
  },
): Promise<Conversation | null> {
  if (!isValidId(id)) return null;
  const found = withTransaction((db) => {
    const exists = db.prepare('SELECT 1 AS x FROM conversations WHERE id = ?').get(id);
    if (!exists) return false;
    if (patch.messages !== undefined) {
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
      const ins = db.prepare(
        'INSERT INTO messages (conversation_id, position, role, content, thinking, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      patch.messages.forEach((m, i) => {
        ins.run(id, i, m.role, m.content, m.thinking ?? null, m.model, m.createdAt);
      });
    }
    // Un PATCH ne contenant que des réglages (folderId, think, useMemory, learnMemory, pinned, connectionId) ne touche pas updated_at.
    const folderOnly =
      (patch.folderId !== undefined ||
        patch.think !== undefined ||
        patch.useMemory !== undefined ||
        patch.learnMemory !== undefined ||
        patch.pinned !== undefined ||
        patch.connectionId !== undefined) &&
      patch.title === undefined &&
      patch.model === undefined &&
      patch.messages === undefined;
    if (!folderOnly) {
      db.prepare(
        'UPDATE conversations SET title = COALESCE(?, title), model = COALESCE(?, model), updated_at = ? WHERE id = ?',
      ).run(patch.title ?? null, patch.model ?? null, new Date().toISOString(), id);
    }
    if (patch.folderId !== undefined) {
      db.prepare('UPDATE conversations SET folder_id = ? WHERE id = ?').run(patch.folderId, id);
    }
    if (patch.think !== undefined) {
      db.prepare('UPDATE conversations SET think = ? WHERE id = ?').run(patch.think ? 1 : 0, id);
    }
    if (patch.useMemory !== undefined) {
      db.prepare('UPDATE conversations SET use_memory = ? WHERE id = ?').run(patch.useMemory ? 1 : 0, id);
    }
    if (patch.learnMemory !== undefined) {
      db.prepare('UPDATE conversations SET learn_memory = ? WHERE id = ?').run(patch.learnMemory ? 1 : 0, id);
    }
    if (patch.pinned !== undefined) {
      db.prepare('UPDATE conversations SET pinned = ? WHERE id = ?').run(patch.pinned ? 1 : 0, id);
    }
    if (patch.connectionId !== undefined) {
      db.prepare('UPDATE conversations SET connection_id = ? WHERE id = ?').run(patch.connectionId, id);
    }
    return true;
  });
  return found ? loadConversation(id) : null;
}

export async function deleteConversation(id: string): Promise<boolean> {
  if (!isValidId(id)) return false;
  const r = getDb().prepare('DELETE FROM conversations WHERE id = ?').run(id);
  return Number(r.changes) > 0;
}

// ---- Dossiers ----

interface FolderRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  conversation_count: number;
  color: string | null;
  icon: string | null;
}
const toFolder = (r: FolderRow): Folder => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  conversationCount: Number(r.conversation_count ?? 0),
  color: isFolderColor(r.color) ? r.color : 'default',
  icon: isFolderIcon(r.icon) ? r.icon : 'folder',
});
const FOLDER_SELECT = `SELECT f.id, f.name, f.color, f.icon, f.created_at, f.updated_at,
  (SELECT COUNT(*) FROM conversations c WHERE c.folder_id = f.id) AS conversation_count
  FROM folders f`;

export async function folderExists(id: unknown): Promise<boolean> {
  if (!isValidId(id)) return false;
  return !!getDb().prepare('SELECT 1 AS x FROM folders WHERE id = ?').get(id);
}

export async function listFolders(): Promise<Folder[]> {
  const rows = getDb()
    .prepare(`${FOLDER_SELECT} ORDER BY f.created_at ASC, f.rowid ASC`)
    .all() as unknown as FolderRow[];
  return rows.map(toFolder);
}

async function getFolder(id: string): Promise<Folder | null> {
  if (!isValidId(id)) return null;
  const r = getDb().prepare(`${FOLDER_SELECT} WHERE f.id = ?`).get(id) as unknown as FolderRow | undefined;
  return r ? toFolder(r) : null;
}

export async function createFolder(name: string): Promise<Folder> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb().prepare('INSERT INTO folders (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, now, now);
  return { id, name, createdAt: now, updatedAt: now, conversationCount: 0, color: 'default', icon: 'folder' };
}

export async function renameFolder(id: string, name: string): Promise<Folder | null> {
  return updateFolder(id, { name });
}

/** Met à jour les champs fournis (nom, couleur, icône) ; les valeurs doivent être déjà validées. */
export async function updateFolder(
  id: string,
  patch: { name?: string; color?: string; icon?: string },
): Promise<Folder | null> {
  if (!isValidId(id)) return null;
  const sets: string[] = [];
  const args: string[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    args.push(patch.name);
  }
  if (patch.color !== undefined) {
    sets.push('color = ?');
    args.push(patch.color);
  }
  if (patch.icon !== undefined) {
    sets.push('icon = ?');
    args.push(patch.icon);
  }
  if (sets.length === 0) return getFolder(id);
  sets.push('updated_at = ?');
  args.push(new Date().toISOString());
  const r = getDb()
    .prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`)
    .run(...args, id);
  return Number(r.changes) > 0 ? getFolder(id) : null;
}

export async function deleteFolder(id: string): Promise<boolean> {
  if (!isValidId(id)) return false;
  return withTransaction((db) => {
    db.prepare('UPDATE conversations SET folder_id = NULL WHERE folder_id = ?').run(id);
    const r = db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    return Number(r.changes) > 0;
  });
}
