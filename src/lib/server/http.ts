export const json = (body: unknown, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const noContent = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

/** Refuse les requêtes envoyées depuis une autre origine (en-tête Origin présent et différent). */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/** Nom de modèle Ollama : chaîne non vide (après trim) de 200 caractères au plus. */
export function validModel(m: unknown): m is string {
  return typeof m === 'string' && m.trim().length > 0 && m.trim().length <= 200;
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
