import type { APIRoute } from 'astro';
import { listConnectionsSecret } from '../../lib/server/connections';
import { json } from '../../lib/server/http';
import { probeConnection } from '../../lib/server/ollama';

export const prerender = false;

export const GET: APIRoute = async () => {
  const conns = listConnectionsSecret().filter((c) => c.enabled);
  const probes = await Promise.all(conns.map((c) => probeConnection(c)));
  const connections = conns.map((c, i) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    online: probes[i].ok,
    latencyMs: probes[i].latencyMs,
  }));
  return json({ online: connections.some((c) => c.online), connections });
};
