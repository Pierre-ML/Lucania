// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';

// Build bureau (Tauri) : toutes les dépendances serveur sont embarquées dans dist/server,
// pour ne pas dépendre de node_modules à l'exécution.
const desktop = process.env.LUCANIA_DESKTOP === '1';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  server: { port: 4748 },
  vite: {
    // Tauri compile dans src-tauri/target : ne pas le surveiller (EBUSY).
    server: { watch: { ignored: ['**/src-tauri/**'] } },
    plugins: [tailwindcss()],
    // Pré-bundlées dès le démarrage : évite un cache .vite périmé (504) qui bloque app.js.
    optimizeDeps: { include: ['marked', 'dompurify'] },
    ...(desktop ? { ssr: { noExternal: true } } : {}),
  },
});
