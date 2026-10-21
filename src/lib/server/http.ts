export const json = (body: unknown, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const noContent = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

/**
 * Refuse les requêtes envoyées depuis une autre origine (en-tête Origin présent et différent).
 * On compare à l'en-tête Host (fixé par le navigateur) car l'adapter node construit toujours request.url avec localhost.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    const host = request.headers.get('host') || new URL(request.url).host;
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Identifiant de modèle GGUF : chemin relatif (lettres, chiffres, . _ - + / espace ( )), 1 à 300 caractères.
 * Préfixe facultatif `server::` : modèle de la tour (mode récepteur).
 */
const MODEL_RE = /^[A-Za-z0-9._+\-/ ()]+$/;
const SERVER_PREFIX = 'server::';
export function validModel(m: unknown): m is string {
  if (typeof m !== 'string') return false;
  let t = m.trim();
  if (t.startsWith(SERVER_PREFIX)) t = t.slice(SERVER_PREFIX.length);
  if (t.length < 1 || t.length > 300) return false;
  if (!MODEL_RE.test(t)) return false;
  if (t.includes('..') || t.startsWith('/')) return false;
  return true;
}

export function validTitle(t: unknown): t is string {
  return typeof t === 'string' && t.trim().length > 0 && t.trim().length <= 200;
}

export function validFolderName(n: unknown): n is string {
  return typeof n === 'string' && n.trim().length > 0 && n.trim().length <= 80;
}

export function validMessage(m: any): boolean {
  return (
    !!m &&
    typeof m === 'object' &&
    (m.role === 'user' || m.role === 'assistant') &&
    typeof m.content === 'string' &&
    (m.thinking === undefined || typeof m.thinking === 'string') &&
    typeof m.model === 'string' &&
    typeof m.createdAt === 'string'
  );
}

export async function readJson(request: Request): Promise<any | undefined> {
  try {
    const b = await request.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? b : undefined;
  } catch {
    return undefined;
  }
}
