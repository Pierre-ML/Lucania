import type { APIRoute } from 'astro';
import { listConnectionsSecret } from '../../lib/server/connections';
import { json } from '../../lib/server/http';
import { probeConnection } from '../../lib/server/ollama';

export const prerender = false;

interface ModelEntry {
  connectionId: string;
  connectionName: string;
  kind: 'local' | 'remote';
  name: string;
  source: 'installed' | 'manual' | 'both';
  available: boolean;
}

export const GET: APIRoute = async () => {
  const conns = listConnectionsSecret().filter((c) => c.enabled);
  const probes = await Promise.all(conns.map((c) => probeConnection(c)));
  const models: ModelEntry[] = [];
  conns.forEach((c, i) => {
    const p = probes[i];
    const installed = new Set(p.ok ? p.models : []);
    const manual = new Set(c.manualModels);
    const names = new Set<string>([...(c.autoModels ? installed : []), ...manual]);
    const entries = [...names].map((name): ModelEntry => {
      const isInst = installed.has(name);
      const isMan = manual.has(name);
      return {
        connectionId: c.id,
        connectionName: c.name,
        kind: c.kind,
        name,
        source: isInst && isMan ? 'both' : isInst ? 'installed' : 'manual',
        available: p.ok && (isInst || !c.autoModels),
      };
    });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
    models.push(...entries);
  });
  return json({ models });
};
