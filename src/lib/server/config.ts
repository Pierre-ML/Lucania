// Serveur uniquement : ne jamais importer côté client.
// Les connexions Ollama sont stockées en base (table `connections`) et gérées depuis la page
// Paramètres. Les variables d'environnement ne servent plus qu'à créer la connexion initiale
// au premier démarrage (voir db.ts) : aucune valeur par défaut ici.
//
// IMPORTANT (confidentialité) : on ne lit JAMAIS `import.meta.env` ici. Vite/Astro remplacent
// `import.meta.env.*` à la compilation, ce qui inlinerait le `.env` du développeur dans le build
// distribué. Seul `process.env` est lu, à l'exécution.

let envLoaded = false;

/** Dev web uniquement : charge `.env` (cwd) à l'exécution, une seule fois. Jamais en mode desktop. */
function loadDevEnv() {
  if (envLoaded) return;
  envLoaded = true;
  if (process.env.LUCANIA_DESKTOP === '1') return;
  try {
    process.loadEnvFile('.env');
  } catch {
    // pas de .env : rien à charger
  }
}

const env = (k: string): string => {
  if (process.env.LUCANIA_DESKTOP === '1') return '';
  loadDevEnv();
  return (process.env[k] ?? '').trim();
};

export interface EnvSeed {
  ollamaUrl: string;
  ollamaModels: string[];
  shutdownUrl: string;
  shutdownMethod: string;
  shutdownToken: string;
}

/** Lecture brute (trim) des anciennes variables d'environnement ; chaînes vides si absentes (et toujours en mode desktop). */
export function envSeed(): EnvSeed {
  return {
    ollamaUrl: env('OLLAMA_URL'),
    ollamaModels: env('OLLAMA_MODELS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    shutdownUrl: env('SHUTDOWN_URL'),
    shutdownMethod: env('SHUTDOWN_METHOD'),
    shutdownToken: env('SHUTDOWN_TOKEN'),
  };
}
