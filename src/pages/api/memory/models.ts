import type { APIRoute } from 'astro';
import { json } from '../../../lib/server/http';
import { listMemoryModels } from '../../../lib/server/memory';

export const GET: APIRoute = async () => json(listMemoryModels());
