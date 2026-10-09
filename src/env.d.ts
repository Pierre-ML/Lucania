interface ImportMetaEnv {
  /** Version de l'app, injectée au build depuis src-tauri/tauri.conf.json. */
  readonly LUCANIA_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
