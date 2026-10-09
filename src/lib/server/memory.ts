// Mémoire persistante : faits par NOM de modèle (quel que soit le serveur). Serveur uniquement.
import crypto from 'node:crypto';
import { getDb, withTransaction } from './db';

export interface Fact {
  id: string;
  model: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}
export interface MemorySettings {
  model: string;
  enabled: boolean;
  autoExtract: boolean;
}
export interface MemoryModel extends MemorySettings {
  count: number;
}
export interface ExtractMessage {
  role: 'user' | 'assistant';
  content: string;
}

export const MAX_FACT_LENGTH = 500;
const MAX_EXTRACTED_LENGTH = 200;
const MAX_EXTRACTED = 3;
const MAX_INPUT_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 4000;

interface FactRow {
  id: string;
  model: string;
  content: string;
  created_at: string;
  updated_at: string;
}
const toFact = (r: FactRow): Fact => ({
  id: r.id,
  model: r.model,
  content: r.content,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Contenu d'un fait : chaîne trimée de 1 à 500 caractères ; null sinon. */
export function parseFactContent(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const c = v.trim();
  return c.length > 0 && c.length <= MAX_FACT_LENGTH ? c : null;
}

// ---- Faits ----

export function listFacts(model: string): Fact[] {
  const rows = getDb()
    .prepare(
      'SELECT id, model, content, created_at, updated_at FROM memory_facts WHERE model = ? ORDER BY created_at ASC, rowid ASC',
    )
    .all(model) as unknown as FactRow[];
  return rows.map(toFact);
}

function getFact(id: string): Fact | null {
  const r = getDb()
    .prepare('SELECT id, model, content, created_at, updated_at FROM memory_facts WHERE id = ?')
    .get(id) as unknown as FactRow | undefined;
  return r ? toFact(r) : null;
}

export function createFact(model: string, content: string): Fact {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  withTransaction((db) => {
    db.prepare('INSERT INTO memory_facts (id, model, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      model,
      content,
      now,
      now,
    );
  });
  return { id, model, content, createdAt: now, updatedAt: now };
}

export function updateFact(id: string, content: string): Fact | null {
  const changed = withTransaction((db) => {
    const r = db
      .prepare('UPDATE memory_facts SET content = ?, updated_at = ? WHERE id = ?')
      .run(content, new Date().toISOString(), id);
    return Number(r.changes) > 0;
  });
  return changed ? getFact(id) : null;
}

export function deleteFact(id: string): boolean {
  return withTransaction((db) => Number(db.prepare('DELETE FROM memory_facts WHERE id = ?').run(id).changes) > 0);
}

// ---- Réglages (sans ligne : enabled = true, autoExtract = true) ----

export function getMemorySettings(model: string): MemorySettings {
  const r = getDb().prepare('SELECT enabled, auto_extract FROM memory_settings WHERE model = ?').get(model) as unknown as
    | { enabled: number; auto_extract: number }
    | undefined;
  return { model, enabled: r ? Number(r.enabled) !== 0 : true, autoExtract: r ? Number(r.auto_extract) !== 0 : true };
}

export function setMemorySettings(model: string, patch: { enabled?: boolean; autoExtract?: boolean }): MemorySettings {
  return withTransaction((db) => {
    const cur = getMemorySettings(model);
    const enabled = patch.enabled ?? cur.enabled;
    const autoExtract = patch.autoExtract ?? cur.autoExtract;
    db.prepare(
      `INSERT INTO memory_settings (model, enabled, auto_extract) VALUES (?, ?, ?)
       ON CONFLICT(model) DO UPDATE SET enabled = excluded.enabled, auto_extract = excluded.auto_extract`,
    ).run(model, enabled ? 1 : 0, autoExtract ? 1 : 0);
    return { model, enabled, autoExtract };
  });
}

/** Modèles ayant des faits OU une ligne de réglages, triés par nom. */
export function listMemoryModels(): MemoryModel[] {
  const rows = getDb()
    .prepare(
      `SELECT m.model AS model,
              (SELECT COUNT(*) FROM memory_facts f WHERE f.model = m.model) AS count,
              COALESCE(s.enabled, 1) AS enabled,
              COALESCE(s.auto_extract, 1) AS auto_extract
       FROM (SELECT model FROM memory_facts UNION SELECT model FROM memory_settings) m
       LEFT JOIN memory_settings s ON s.model = m.model
       ORDER BY m.model ASC`,
    )
    .all() as unknown as { model: string; count: number; enabled: number; auto_extract: number }[];
  return rows.map((r) => ({
    model: r.model,
    count: Number(r.count),
    enabled: Number(r.enabled) !== 0,
    autoExtract: Number(r.auto_extract) !== 0,
  }));
}

// ---- Injection dans le chat ----

/** Message système listant les faits du modèle (langue de l'interface), ou null s'il n'y a rien à injecter. */
export function buildMemorySystemMessage(model: string, lang: 'fr' | 'en'): string | null {
  if (!getMemorySettings(model).enabled) return null;
  const facts = listFacts(model);
  if (facts.length === 0) return null;
  const intro =
    lang === 'en'
      ? 'Here is what you know about the user (use only when relevant):'
      : "Voici ce que tu sais de l'utilisateur (à utiliser seulement si c'est pertinent) :";
  return `${intro}\n${facts.map((f) => `- ${f.content}`).join('\n')}`;
}

// ---- Extraction de faits ----

const FACTS_SCHEMA = {
  type: 'object',
  properties: { facts: { type: 'array', items: { type: 'string' } } },
  required: ['facts'],
};

function extractionPrompt(lang: 'fr' | 'en', known: string[]): string {
  const list = known.map((k) => `- ${k}`).join('\n');
  if (lang === 'en') {
    return [
      'You extract durable facts about the USER from a conversation.',
      'Return between 0 and 3 short facts (one sentence each, 200 characters at most) about the user: preferences, identity, projects, stable context.',
      'Never return ephemeral facts (the current question, the mood of the moment, a one-off task) and never anything about the assistant.',
      known.length ? `Facts already known (do not repeat them, even reworded):\n${list}` : 'No fact is known yet.',
      'Answer only with JSON of the form {"facts": ["..."]}. If there is nothing durable to remember, answer {"facts": []}.',
    ].join('\n');
  }
  return [
    "Tu extrais d'une conversation des faits DURABLES sur l'UTILISATEUR.",
    "Renvoie entre 0 et 3 faits courts (une phrase chacun, 200 caractères au plus) sur l'utilisateur : préférences, identité, projets, contexte stable.",
    "Jamais de faits éphémères (la question du moment, l'humeur, une tâche ponctuelle) et jamais d'informations sur l'assistant.",
    known.length ? `Faits déjà connus (ne les répète pas, même reformulés) :\n${list}` : "Aucun fait n'est encore connu.",
    "Réponds uniquement avec du JSON de la forme {\"facts\": [\"...\"]}. S'il n'y a rien de durable à retenir, réponds {\"facts\": []}.",
  ].join('\n');
}

/** Lecture tolérante de la réponse du modèle : JSON invalide → []. */
function parseFacts(raw: unknown, known: string[]): string[] {
  if (typeof raw !== 'string') return [];
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) return [];
    try {
      data = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }
  const items = Array.isArray(data) ? data : data && typeof data === 'object' ? data.facts : undefined;
  if (!Array.isArray(items)) return [];
  const seen = new Set(known.map((k) => k.trim().toLowerCase()));
  const out: string[] = [];
  for (const it of items) {
    if (typeof it !== 'string') continue;
    const f = it.trim();
    if (!f || f.length > MAX_EXTRACTED_LENGTH) continue;
    const key = f.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
    if (out.length >= MAX_EXTRACTED) break;
  }
  return out;
}

export type ExtractResult = { ok: true; facts: string[] } | { ok: false; error: string };

/**
 * Demande à Ollama (non-streaming) 0 à 3 faits durables à retenir. N'enregistre rien.
 * Renvoie { facts: [] } sans appeler Ollama si la mémoire ou l'extraction est désactivée pour ce modèle.
 */
export async function extractFacts(input: {
  baseUrl: string;
  model: string;
  messages: ExtractMessage[];
  lang: 'fr' | 'en';
}): Promise<ExtractResult> {
  const { baseUrl, model, lang } = input;
  const settings = getMemorySettings(model);
  if (!settings.enabled || !settings.autoExtract) return { ok: true, facts: [] };

  const known = listFacts(model).map((f) => f.content);
  const messages = input.messages.slice(-MAX_INPUT_MESSAGES).map((m) => ({
    role: m.role,
    content: m.content.slice(0, MAX_MESSAGE_LENGTH),
  }));

  const send = (withThink: boolean) =>
    fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: extractionPrompt(lang, known) }, ...messages],
        stream: false,
        format: FACTS_SCHEMA,
        ...(withThink && { think: false }),
        options: { temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(60_000),
    });

  try {
    let upstream = await send(true);
    if (!upstream.ok && upstream.status === 400) {
      const text = await upstream.text().catch(() => '');
      if (/does not support thinking/i.test(text)) upstream = await send(false);
      else return { ok: false, error: text.trim() || `Erreur Ollama (HTTP ${upstream.status})` };
    }
    if (!upstream.ok) {
      const text = (await upstream.text().catch(() => '')).trim();
      return { ok: false, error: text || `Erreur Ollama (HTTP ${upstream.status})` };
    }
    const data = (await upstream.json().catch(() => null)) as any;
    return { ok: true, facts: parseFacts(data?.message?.content, known) };
  } catch {
    return { ok: false, error: 'Serveur injoignable' };
  }
}
