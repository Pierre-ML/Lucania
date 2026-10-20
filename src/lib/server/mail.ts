// E-mails non lus : réglages (table `mail_settings`, une seule ligne) et client IMAP minimal en lecture seule.
// Serveur uniquement. Le mot de passe n'est JAMAIS renvoyé au client (seul `hasPassword` est exposé)
// et n'apparaît jamais dans les journaux ni dans les messages d'erreur.
import net from 'node:net';
import tls from 'node:tls';
import { getDb, withTransaction } from './db';
import { validModel } from './http';

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------

export interface MailSettingsPublic {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  hasPassword: boolean;
  mailbox: string;
  model: string;
  maxEmails: number;
}

/** Vue interne (serveur) incluant le mot de passe : ne jamais sérialiser vers le client. */
export interface MailSettingsSecret {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox: string;
  model: string;
  maxEmails: number;
}

interface MailRow {
  host: string;
  port: number;
  secure: number;
  user: string;
  password: string;
  mailbox: string;
  model: string;
  max_emails: number;
}

const DEFAULTS: MailSettingsSecret = {
  host: '',
  port: 993,
  secure: true,
  user: '',
  password: '',
  mailbox: 'INBOX',
  model: '',
  maxEmails: 30,
};

export function getMailSettingsSecret(): MailSettingsSecret {
  const r = getDb()
    .prepare('SELECT host, port, secure, user, password, mailbox, model, max_emails FROM mail_settings WHERE id = 1')
    .get() as unknown as MailRow | undefined;
  if (!r) return { ...DEFAULTS };
  return {
    host: r.host,
    port: Number(r.port),
    secure: Number(r.secure) !== 0,
    user: r.user,
    password: r.password,
    mailbox: r.mailbox || 'INBOX',
    model: r.model,
    maxEmails: Number(r.max_emails),
  };
}

/** Retire le mot de passe : forme publique conforme au contrat. */
export function publicMailSettings(s: MailSettingsSecret): MailSettingsPublic {
  return {
    host: s.host,
    port: s.port,
    secure: s.secure,
    user: s.user,
    hasPassword: s.password !== '',
    mailbox: s.mailbox,
    model: s.model,
    maxEmails: s.maxEmails,
  };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const isLocalHost = (h: string) => LOCAL_HOSTS.has(h.trim().toLowerCase());
const HOST_RE = /^[A-Za-z0-9._:-]{1,253}$/;
const CTRL_RE = /[\u0000-\u001f\u007f]/;

export interface MailSettingsChanges {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** Nouveau mot de passe ; undefined = conserver l'ancien. */
  password?: string;
  clearPassword: boolean;
  mailbox: string;
  model: string;
  maxEmails: number;
}

/** Valide le corps d'un PUT. Les champs absents gardent la valeur actuelle (`cur`). */
export function parseMailSettingsInput(
  body: any,
  cur: MailSettingsSecret,
): { ok: true; value: MailSettingsChanges } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });

  let host = cur.host;
  if (body.host !== undefined) {
    if (typeof body.host !== 'string') return fail('Serveur invalide');
    host = body.host.trim();
    if (host !== '' && !HOST_RE.test(host))
      return fail('Serveur invalide (nom d’hôte seul, sans schéma, sans espace ni chemin)');
  }

  let port = cur.port;
  if (body.port !== undefined) {
    if (typeof body.port !== 'number' || !Number.isInteger(body.port) || body.port < 1 || body.port > 65535)
      return fail('Port invalide (1 à 65535)');
    port = body.port;
  }

  let secure = cur.secure;
  if (body.secure !== undefined) {
    if (typeof body.secure !== 'boolean') return fail('secure invalide');
    secure = body.secure;
  }
  if (!secure && host !== '' && !isLocalHost(host))
    return fail('Connexion non chiffrée refusée : sans TLS, seuls localhost et 127.0.0.1 sont autorisés');

  let user = cur.user;
  if (body.user !== undefined) {
    if (typeof body.user !== 'string') return fail('Identifiant invalide');
    user = body.user.trim();
    if (user.length > 254 || user.includes('\0')) return fail('Identifiant invalide (254 caractères maximum)');
  }

  let password: string | undefined;
  if (body.password !== undefined) {
    if (typeof body.password !== 'string' || body.password.length > 500 || body.password.includes('\0'))
      return fail('Mot de passe invalide (500 caractères maximum)');
    if (body.password !== '') password = body.password;
  }
  if (body.clearPassword !== undefined && typeof body.clearPassword !== 'boolean')
    return fail('clearPassword invalide');
  const clearPassword = body.clearPassword === true && password === undefined;

  let mailbox = cur.mailbox;
  if (body.mailbox !== undefined) {
    if (typeof body.mailbox !== 'string') return fail('Boîte invalide');
    mailbox = body.mailbox.trim() || 'INBOX';
    if (mailbox.length > 100 || CTRL_RE.test(mailbox)) return fail('Boîte invalide (100 caractères maximum)');
  }

  let model = cur.model;
  if (body.model !== undefined) {
    if (typeof body.model !== 'string') return fail('Modèle invalide');
    model = body.model.trim();
    if (model !== '' && !validModel(model)) return fail('Modèle invalide');
  }

  let maxEmails = cur.maxEmails;
  if (body.maxEmails !== undefined) {
    if (
      typeof body.maxEmails !== 'number' ||
      !Number.isInteger(body.maxEmails) ||
      body.maxEmails < 1 ||
      body.maxEmails > 100
    )
      return fail('Nombre d’e-mails invalide (1 à 100)');
    maxEmails = body.maxEmails;
  }

  return { ok: true, value: { host, port, secure, user, password, clearPassword, mailbox, model, maxEmails } };
}

export function saveMailSettings(v: MailSettingsChanges): MailSettingsSecret {
  withTransaction((db) => {
    const cur = getMailSettingsSecret();
    const password = v.clearPassword ? '' : (v.password ?? cur.password);
    db.prepare(
      `INSERT OR REPLACE INTO mail_settings
         (id, host, port, secure, user, password, mailbox, model, max_emails, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(v.host, v.port, v.secure ? 1 : 0, v.user, password, v.mailbox, v.model, v.maxEmails, new Date().toISOString());
  });
  return getMailSettingsSecret();
}

// ---------------------------------------------------------------------------
// Client IMAP minimal (lecture seule : EXAMINE + BODY.PEEK, rien n'est marqué comme lu)
// ---------------------------------------------------------------------------

export interface UnreadEmail {
  uid: number;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

/** Erreur dont le message (FR) peut être montré à l'utilisateur. */
export class MailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailError';
  }
}

const TIMEOUT_MS = 20_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const SNIPPET_MAX = 1500;
const BODY_PREFIX_BYTES = 4000;

type Arg = string | { raw: string };

const needsLiteral = (s: string) => /[^\x20-\x7e]/.test(s);
const quoteImap = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Fin (exclue) de la première ligne complète, ou -1. */
function firstLineEnd(buf: Buffer): number {
  const i = buf.indexOf('\r\n');
  return i < 0 ? -1 : i + 2;
}

/**
 * Parcourt la réponse en sautant les literals {n} (comptés en octets).
 * Renvoie la fin de la ligne taguée `tag OK|NO|BAD`, ou -1 si la réponse est incomplète.
 */
function taggedEnd(tag: string) {
  return (buf: Buffer): number => {
    let pos = 0;
    let cont = false; // la ligne courante prolonge un literal : jamais une ligne taguée
    while (pos < buf.length) {
      const eol = buf.indexOf('\r\n', pos);
      if (eol < 0) return -1;
      const line = buf.toString('latin1', pos, eol);
      const m = /\{(\d+)\+?\}$/.exec(line);
      if (m) {
        const n = Number(m[1]);
        if (n > MAX_BUFFER) throw new MailError('Réponse du serveur trop volumineuse');
        const end = eol + 2 + n;
        if (end > buf.length) return -1;
        pos = end;
        cont = true;
        continue;
      }
      if (!cont && line.startsWith(tag + ' ')) return eol + 2;
      pos = eol + 2;
      cont = false;
    }
    return -1;
  };
}

/** Attend une ligne de continuation `+` ou la ligne taguée (échec). */
function contOrTagged(tag: string) {
  return (buf: Buffer): number => {
    let pos = 0;
    while (pos < buf.length) {
      const eol = buf.indexOf('\r\n', pos);
      if (eol < 0) return -1;
      const line = buf.toString('latin1', pos, eol);
      if (line.startsWith('+') || line.startsWith(tag + ' ')) return eol + 2;
      pos = eol + 2;
    }
    return -1;
  };
}

function lastLine(buf: Buffer): string {
  const end = buf.length - 2;
  const i = end > 0 ? buf.lastIndexOf('\r\n', end - 1) : -1;
  return buf.toString('latin1', i < 0 ? 0 : i + 2, Math.max(0, end));
}

interface CmdResult {
  out: Buffer;
  status: 'OK' | 'NO' | 'BAD';
}

class Session {
  private buf: Buffer = Buffer.alloc(0);
  private waiter: { test: (b: Buffer) => number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null =
    null;
  private error: Error | null = null;
  private closed = false;
  private seq = 0;

  constructor(readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      if (this.buf.length > MAX_BUFFER) {
        this.fail(new MailError('Réponse du serveur trop volumineuse'));
        socket.destroy();
        return;
      }
      this.check();
    });
    socket.on('error', (e) => this.fail(mapNetError(e)));
    socket.on('close', () => {
      this.closed = true;
      this.check();
    });
  }

  fail(e: Error) {
    if (!this.error) this.error = e;
    this.check();
  }

  private check() {
    const w = this.waiter;
    if (!w) return;
    if (this.error) {
      this.waiter = null;
      w.reject(this.error);
      return;
    }
    let n: number;
    try {
      n = w.test(this.buf);
    } catch (e) {
      this.waiter = null;
      w.reject(e as Error);
      return;
    }
    if (n >= 0) {
      const out = this.buf.subarray(0, n);
      this.buf = this.buf.subarray(n);
      this.waiter = null;
      w.resolve(out);
    } else if (this.closed) {
      this.waiter = null;
      w.reject(new MailError('Connexion fermée par le serveur'));
    }
  }

  waitFor(test: (b: Buffer) => number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.waiter = { test, resolve, reject };
      this.check();
    });
  }

  write(data: string | Buffer) {
    this.socket.write(data);
  }

  private result(out: Buffer): CmdResult {
    const m = /^\S+ (OK|NO|BAD)/i.exec(lastLine(out));
    return { out, status: (m ? m[1].toUpperCase() : 'BAD') as CmdResult['status'] };
  }

  /** Envoie une commande (arguments quotés, ou literal si non ASCII / CR / LF) et attend la réponse taguée. */
  async command(verb: string, args: Arg[] = []): Promise<CmdResult> {
    const tag = `A${++this.seq}`;
    let line = `${tag} ${verb}`;
    for (const a of args) {
      if (typeof a !== 'string') {
        line += ' ' + a.raw;
      } else if (needsLiteral(a)) {
        const b = Buffer.from(a, 'utf8');
        this.write(`${line} {${b.length}}\r\n`);
        const got = await this.waitFor(contOrTagged(tag));
        if (!lastLine(got).startsWith('+')) return this.result(got); // refus du serveur
        this.write(b);
        line = '';
      } else {
        line += ' ' + quoteImap(a);
      }
    }
    this.write(line + '\r\n');
    return this.result(await this.waitFor(taggedEnd(tag)));
  }
}

function mapNetError(e: unknown): Error {
  if (e instanceof MailError) return e;
  const code = (e as NodeJS.ErrnoException)?.code ?? '';
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new MailError('Hôte introuvable : vérifiez le nom du serveur');
    case 'ECONNREFUSED':
      return new MailError('Connexion refusée par le serveur : vérifiez l’hôte et le port');
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'ETIMEDOUT':
      return new MailError('Hôte injoignable');
    case 'ECONNRESET':
    case 'EPIPE':
      return new MailError('Connexion interrompue par le serveur (port ou chiffrement incorrect ?)');
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return new MailError('Certificat du serveur non valide : connexion refusée');
    default:
      if (code.startsWith('ERR_SSL') || code.startsWith('ERR_TLS'))
        return new MailError('Échec de la négociation TLS (port ou chiffrement incorrect ?)');
      return new MailError('Erreur réseau lors de la connexion au serveur');
  }
}

// ---- Décodage ----

function decodeBytes(buf: Buffer, charset?: string): string {
  const cs = (charset || '').trim().toLowerCase().replace(/\*.*$/, '');
  if (cs) {
    try {
      return new TextDecoder(cs).decode(buf);
    } catch {
      /* charset inconnu : repli ci-dessous */
    }
  }
  const s = new TextDecoder('utf-8').decode(buf);
  const bad = s.split('�').length - 1;
  return bad > 1 ? buf.toString('latin1') : s;
}

function decodeQP(s: string, headerMode: boolean): Buffer {
  const t = headerMode ? s : s.replace(/=[ \t]*\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 0x3d && /^[0-9A-Fa-f]{2}$/.test(t.substr(i + 1, 2))) {
      bytes.push(parseInt(t.substr(i + 1, 2), 16));
      i += 2;
    } else if (headerMode && c === 0x5f) {
      bytes.push(0x20);
    } else {
      bytes.push(c & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** Décode les mots encodés RFC 2047 (=?charset?B|Q?...?=). */
function decodeMimeWords(s: string): string {
  const joined = s.replace(/(\?=)\s+(?==\?)/g, '$1');
  return joined.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs: string, enc: string, text: string) => {
    try {
      const raw =
        enc.toLowerCase() === 'b' ? Buffer.from(text, 'base64') : decodeQP(text, true);
      return decodeBytes(raw, cs.replace(/\*.*$/, ''));
    } catch {
      return text;
    }
  });
}

function parseHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!(name in out)) out[name] = line.slice(i + 1).trim();
  }
  return out;
}

function headerParam(value: string, name: string): string {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(value);
  return m ? (m[1] ?? m[2] ?? '') : '';
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ecirc: 'ê',
  ccedil: 'ç',
  hellip: '…',
  rsquo: '’',
  euro: '€',
};

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/<[^>]*$/, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

function normalizeSnippet(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f­͏​-‏⁠﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SNIPPET_MAX);
}

function decodeBody(body: string, cte: string, charset: string): string {
  const enc = cte.trim().toLowerCase();
  let raw: Buffer;
  if (enc === 'base64') raw = Buffer.from(body.replace(/[^A-Za-z0-9+/]/g, ''), 'base64');
  else if (enc === 'quoted-printable') raw = decodeQP(body, false);
  else raw = Buffer.from(body, 'latin1');
  return decodeBytes(raw, charset);
}

function splitMultipart(body: string, boundary: string): string[] {
  const segs = body.split('--' + boundary);
  const parts: string[] = [];
  for (let i = 1; i < segs.length; i++) {
    let seg = segs[i];
    if (seg.startsWith('--')) break; // marqueur de fin
    const nl = seg.indexOf('\n');
    seg = nl < 0 ? '' : seg.slice(nl + 1);
    parts.push(seg);
  }
  return parts;
}

function splitPart(seg: string): { headers: Record<string, string>; body: string } {
  const lead = /^\r?\n/.exec(seg);
  if (lead) return { headers: {}, body: seg.slice(lead[0].length) };
  const m = /\r?\n\r?\n/.exec(seg);
  if (!m) return { headers: parseHeaders(seg), body: '' };
  return { headers: parseHeaders(seg.slice(0, m.index)), body: seg.slice(m.index + m[0].length) };
}

/** Cherche le premier texte brut et le premier HTML d'une entité MIME (récursif, profondeur bornée). */
function collect(h: Record<string, string>, body: string, depth: number): { plain: string; html: string } {
  const ct = h['content-type'] || 'text/plain';
  const type = ct.split(';')[0].trim().toLowerCase();
  if (type.startsWith('multipart/')) {
    const res = { plain: '', html: '' };
    const boundary = headerParam(ct, 'boundary');
    if (!boundary || depth > 3) return res;
    for (const seg of splitMultipart(body, boundary)) {
      const p = splitPart(seg);
      const r = collect(p.headers, p.body, depth + 1);
      if (!res.plain && r.plain) res.plain = r.plain;
      if (!res.html && r.html) res.html = r.html;
      if (res.plain) break;
    }
    return res;
  }
  if (/attachment/i.test(h['content-disposition'] || '')) return { plain: '', html: '' };
  if (type !== 'text/plain' && type !== 'text/html') return { plain: '', html: '' };
  const text = decodeBody(body, h['content-transfer-encoding'] || '', headerParam(ct, 'charset'));
  return type === 'text/html' ? { plain: '', html: text } : { plain: text, html: '' };
}

function buildSnippet(h: Record<string, string>, body: Buffer): string {
  const r = collect(h, body.toString('latin1'), 0);
  return normalizeSnippet(r.plain || stripHtml(r.html));
}

function toDateString(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v.slice(0, 100) : d.toISOString();
}

// ---- Analyse des réponses FETCH ----

interface FetchRec {
  uid: number;
  header: Buffer | null;
  text: Buffer | null;
}

/** Extrait les enregistrements `* n FETCH (...)` en comptant les literals en octets. */
function parseFetch(buf: Buffer): FetchRec[] {
  const recs: FetchRec[] = [];
  let cur: FetchRec | null = null;
  let pos = 0;
  let cont = false;
  while (pos < buf.length) {
    const eol = buf.indexOf('\r\n', pos);
    if (eol < 0) break;
    const line = buf.toString('latin1', pos, eol);
    const m = /\{(\d+)\+?\}$/.exec(line);
    const text = m ? line.slice(0, m.index) : line;
    if (!cont) {
      if (/^\* \d+ FETCH \(/i.test(text)) {
        cur = { uid: 0, header: null, text: null };
        recs.push(cur);
      } else {
        cur = null;
      }
    }
    if (cur) {
      const u = /\bUID (\d+)/i.exec(text);
      if (u) cur.uid = Number(u[1]);
    }
    if (m) {
      const n = Number(m[1]);
      const start = eol + 2;
      const end = start + n;
      if (end > buf.length) break;
      if (cur) {
        const data = Buffer.from(buf.subarray(start, end));
        if (/BODY\[HEADER/i.test(text)) cur.header = data;
        else if (/BODY\[TEXT\]/i.test(text)) cur.text = data;
      }
      pos = end;
      cont = true;
    } else {
      pos = eol + 2;
      cont = false;
    }
  }
  return recs.filter((r) => r.uid > 0);
}

function recToEmail(r: FetchRec): UnreadEmail {
  const headerStr = r.header ? decodeBytes(r.header) : '';
  const h = parseHeaders(headerStr);
  return {
    uid: r.uid,
    from: decodeMimeWords(h['from'] || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    subject: decodeMimeWords(h['subject'] || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    date: h['date'] ? toDateString(h['date']) : '',
    snippet: r.text ? buildSnippet(h, r.text) : '',
  };
}

// ---- Connexion et session ----

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox: string;
  maxEmails: number;
}

function connect(cfg: ImapConfig, onSocket: (s: net.Socket) => void): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const host = cfg.host.trim();
    if (!cfg.secure && !isLocalHost(host)) {
      reject(new MailError('Connexion non chiffrée refusée : sans TLS, seuls localhost et 127.0.0.1 sont autorisés'));
      return;
    }
    let sock: net.Socket;
    try {
      sock = cfg.secure
        ? tls.connect({
            host,
            port: cfg.port,
            servername: net.isIP(host) === 0 ? host : undefined,
            minVersion: 'TLSv1.2',
            rejectUnauthorized: true,
          })
        : net.connect({ host, port: cfg.port });
    } catch (e) {
      reject(mapNetError(e));
      return;
    }
    onSocket(sock); // publiée tout de suite : le délai global peut la détruire même pendant la connexion
    const onErr = (e: Error) => reject(mapNetError(e));
    sock.once('error', onErr);
    sock.once(cfg.secure ? 'secureConnect' : 'connect', () => {
      sock.removeListener('error', onErr);
      resolve(sock);
    });
  });
}

async function runCommands(s: Session, cfg: ImapConfig): Promise<UnreadEmail[]> {
  const greeting = (await s.waitFor(firstLineEnd)).toString('latin1');
  if (!/^\* (OK|PREAUTH)\b/i.test(greeting)) throw new MailError('Le serveur a refusé la connexion');

  if (!/^\* PREAUTH\b/i.test(greeting)) {
    const login = await s.command('LOGIN', [cfg.user, cfg.password]);
    if (login.status !== 'OK')
      throw new MailError(
        'Identifiants refusés par le serveur (certains services exigent un mot de passe d’application)',
      );
  }

  // EXAMINE = SELECT en lecture seule : aucun drapeau ne peut être modifié.
  const sel = await s.command('EXAMINE', [cfg.mailbox]);
  if (sel.status !== 'OK') throw new MailError(`Boîte « ${cfg.mailbox.slice(0, 100)} » introuvable ou inaccessible`);

  const search = await s.command('UID SEARCH', [{ raw: 'UNSEEN' }]);
  if (search.status !== 'OK') throw new MailError('La recherche des e-mails non lus a échoué');
  const sm = /^\* SEARCH([\d ]*)\r?$/im.exec(search.out.toString('latin1'));
  const uids = (sm ? sm[1].trim().split(/\s+/).filter(Boolean).map(Number) : [])
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b)
    .slice(-cfg.maxEmails);

  let emails: UnreadEmail[] = [];
  if (uids.length > 0) {
    const spec =
      `(UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] ` +
      `BODY.PEEK[TEXT]<0.${BODY_PREFIX_BYTES}>)`;
    const f = await s.command('UID FETCH', [{ raw: uids.join(',') }, { raw: spec }]);
    if (f.status !== 'OK') throw new MailError('La lecture des e-mails a échoué');
    emails = parseFetch(f.out)
      .map(recToEmail)
      .sort((a, b) => b.uid - a.uid);
  }

  try {
    await s.command('LOGOUT');
  } catch {
    /* sans importance */
  }
  return emails;
}

async function runSession(cfg: ImapConfig, onSocket: (s: net.Socket) => void): Promise<UnreadEmail[]> {
  const sock = await connect(cfg, onSocket);
  const s = new Session(sock);
  try {
    return await runCommands(s, cfg);
  } catch (e) {
    sock.destroy();
    throw mapNetError(e);
  }
}

/** Récupère les e-mails non lus (sans les marquer comme lus). Lève MailError avec un message FR. */
export async function fetchUnread(cfg: ImapConfig): Promise<UnreadEmail[]> {
  const conf: ImapConfig = { ...cfg, maxEmails: Math.min(100, Math.max(1, Math.trunc(cfg.maxEmails) || 30)) };
  let sockRef: net.Socket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      sockRef?.destroy();
      reject(new MailError('Délai dépassé (20 s) : le serveur ne répond pas'));
    }, TIMEOUT_MS);
  });
  const work = runSession(conf, (s) => {
    sockRef = s;
  });
  work.catch(() => {}); // évite un rejet non géré si le délai l'emporte
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    (sockRef as net.Socket | null)?.destroy();
  }
}
