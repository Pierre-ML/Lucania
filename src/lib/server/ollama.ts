// Sondes vers les serveurs Ollama (joignabilité, modèles installés). Serveur uniquement.
import type { ConnectionSecret } from './connections';

export interface Probe {
  ok: boolean;
  latencyMs: number | null;
  models: string[];
  error: string | null;
}

export interface TestResult extends Probe {
  version: string | null;
}

class Unexpected extends Error {}

/** Message lisible (français) pour une erreur de fetch ; ne contient jamais l'URL. */
function describeFetchError(e: unknown): string {
  const err = e as any;
  if (err instanceof Unexpected) return err.message;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'Injoignable (délai dépassé)';
  const cause = err?.cause;
  if (cause?.message === 'bad port') return 'Port non autorisé (choisissez un autre port)';
  const code: string = cause?.code ?? cause?.errors?.[0]?.code ?? err?.code ?? '';
  switch (code) {
    case 'ECONNREFUSED':
      return 'Connexion refusée';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Hôte introuvable';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EHOSTDOWN':
      return 'Hôte inaccessible (réseau)';
    case 'ECONNRESET':
    case 'UND_ERR_SOCKET':
      return 'Connexion interrompue';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return 'Injoignable (délai dépassé)';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'Certificat TLS refusé';
    default:
      return 'Injoignable';
  }
}

async function getJson(url: string, signal: AbortSignal): Promise<any> {
  const r = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!r.ok) {
    await r.body?.cancel().catch(() => {});
    throw new Unexpected(`Réponse inattendue (HTTP ${r.status})`);
  }
  try {
    return await r.json();
  } catch (e) {
    if ((e as any)?.name === 'TimeoutError' || (e as any)?.name === 'AbortError') throw e;
    throw new Unexpected("Réponse inattendue (ce n'est pas un serveur Ollama ?)");
  }
}

/** GET {baseUrl}/api/tags. Ne lève jamais d'exception. */
async function fetchTags(baseUrl: string, timeoutMs: number): Promise<Probe> {
  const t0 = performance.now();
  try {
    const d = await getJson(`${baseUrl}/api/tags`, AbortSignal.timeout(timeoutMs));
    if (!d || typeof d !== 'object' || !Array.isArray(d.models))
      throw new Unexpected("Réponse inattendue (ce n'est pas un serveur Ollama ?)");
    const models = [
      ...new Set<string>(
        d.models.map((m: any) => m?.name ?? m?.model).filter((n: unknown): n is string => typeof n === 'string'),
      ),
    ];
    return { ok: true, latencyMs: Math.round(performance.now() - t0), models, error: null };
  } catch (e) {
    return { ok: false, latencyMs: null, models: [], error: describeFetchError(e) };
  }
}

/** Test complet d'une adresse : /api/tags + /api/version en parallèle (timeout 4 s). */
export async function testBaseUrl(baseUrl: string): Promise<TestResult> {
  const versionP = getJson(`${baseUrl}/api/version`, AbortSignal.timeout(4000))
    .then((d) => (d && typeof d.version === 'string' ? d.version : null))
    .catch(() => null);
  const [tags, version] = await Promise.all([fetchTags(baseUrl, 4000), versionP]);
  return { ...tags, version: tags.ok ? version : null };
}

// ---- Cache mémoire par connexion (15 s), partagé par /api/models et /api/status ----

const CACHE_MS = 15_000;
const PROBE_TIMEOUT_MS = 3_000;

interface Entry {
  baseUrl: string;
  at: number;
  probe?: Probe;
  pending?: Promise<Probe>;
}
const G = globalThis as unknown as { __iaProbeCache?: Map<string, Entry> };
const cache = (G.__iaProbeCache ??= new Map<string, Entry>());

/** Sonde une connexion via le cache (15 s) ; les sondes simultanées sont mutualisées. */
export function probeConnection(c: Pick<ConnectionSecret, 'id' | 'baseUrl'>): Promise<Probe> {
  const e = cache.get(c.id);
  if (e && e.baseUrl === c.baseUrl) {
    if (e.pending) return e.pending;
    if (e.probe && Date.now() - e.at < CACHE_MS) return Promise.resolve(e.probe);
  }
  const entry: Entry = { baseUrl: c.baseUrl, at: Date.now() };
  entry.pending = fetchTags(c.baseUrl, PROBE_TIMEOUT_MS).then((p) => {
    entry.probe = p;
    entry.at = Date.now();
    entry.pending = undefined;
    return p;
  });
  cache.set(c.id, entry);
  return entry.pending;
}

/** Enregistre un résultat de sonde obtenu ailleurs (ex. test manuel). */
export function rememberProbe(id: string, baseUrl: string, probe: Probe) {
  cache.set(id, { baseUrl, at: Date.now(), probe: { ...probe } });
}

export function invalidateProbe(id: string) {
  cache.delete(id);
}
