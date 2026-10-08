import { defineMiddleware } from 'astro:middleware';

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' http://localhost:11434 ipc: http://ipc.localhost",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

// CSP uniquement en production (le HMR de Vite en dev a besoin de websockets/eval).
export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  if (import.meta.env.PROD && response.headers.get('content-type')?.includes('text/html')) {
    response.headers.set('Content-Security-Policy', CSP);
  }
  return response;
});
