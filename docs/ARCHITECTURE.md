# Architecture de Lucania

Vue d'ensemble technique, au niveau des fichiers et des modules (les noms de fonctions changent vite, pas les modules). Version décrite : 0.4.0. Guide rapide : `CLAUDE.md`. Accès à une autre machine : [wireguard.md](wireguard.md).

## 1. Vue d'ensemble

Lucania est une app de bureau Windows (Tauri v2) qui contient deux parties :

- Un **serveur web Astro** (Node, mode standalone) : pages, routes `/api/**`, base SQLite. En bureau, le binaire `node.exe` (sidecar `binaries/node`) le lance sur `127.0.0.1:4749`.
- Un **processus Tauri (Rust)** : fenêtre, moteur llama.cpp, téléchargements Hugging Face, serveur et client distants, mise à jour, journaux de diagnostic.

Les pages (JS vanilla) parlent à Node par `fetch('/api/...')` et à Rust par `invoke(...)` et les événements Tauri.

Le moteur et Hugging Face sont dans Rust, pas dans Node. Le dev web (`npm run dev`, port 4748) affiche l'interface mais le chat n'y fonctionne pas : il faut `npm run tauri dev`.

## 2. Ports et dossiers

| Élément | Valeur |
| --- | --- |
| Dev web | `localhost:4748` (`astro.config.mjs`) |
| Serveur Node embarqué (bureau) | `127.0.0.1:4749` (`src-tauri/src/lib.rs`) |
| API de la tour (mode serveur) | 4750 par défaut, modifiable (`server/net.rs`) |
| Découverte réseau de la tour | UDP 4751 (`server/discovery.rs`) |

Données :

- Base SQLite : `data/app.db` en dev, `%APPDATA%\com.lucania.desktop\data\app.db` en bureau (variable `LUCANIA_DATA_DIR`, posée par `lib.rs`).
- Côté Rust, dans `%LOCALAPPDATA%\com.lucania.desktop` : `models/` (modèles GGUF), `model-profiles.json` (réglages par modèle), `hf-token`, `hf-cache/`, `server.json`, `remote.json`, `logs-crash/`.
- Dossier de travail : `Documents\Lucania` (créé au démarrage, seul dossier ouvert aux plugins fs et shell).

## 3. Pages Astro (`src/pages`)

| Page | Rôle |
| --- | --- |
| `index.astro` | Chat : barre latérale, en-tête, liste de messages, zone de saisie, fenêtres « Ajouter un modèle » et « Réglages du modèle » |
| `emails.astro` | Tri des e-mails non lus par un modèle local (comptes IMAP, catégories, réglages de l'IA du tri) |
| `parametres.astro` | Paramètres : Moteur, Hugging Face, Mémoire, Apparence, À propos |
| `connexion.astro` | Accès distant : assistant guidé (rôle serveur ou récepteur), Connexions, Extinction à distance |
| `serveur.astro` | Écran affiché tant que le mode serveur tourne (un bouton Arrêter, l'adresse d'écoute) |

`Layout.astro` pose le thème et la langue. `src/middleware.ts` ajoute la CSP aux pages HTML, en production seulement.

## 4. Routes API (`src/pages/api`)

Toutes répondent en JSON. Les routes sensibles (e-mails, mémoire, connexions, extinction) vérifient l'origine (`sameOrigin` dans `lib/server/http.ts`). Les messages d'erreur serveur sont en français.

| Route | Rôle |
| --- | --- |
| `conversations`, `conversations/[id]` | CRUD des conversations et de leurs messages |
| `folders`, `folders/[id]` | Dossiers (nom, couleur, icône) |
| `connections`, `connections/[id]` | Connexions d'extinction à distance |
| `shutdown` | Envoie la requête d'extinction (GET ou POST) d'une connexion |
| `system` | Mode bureau ou non, dossier de données, version |
| `memory`, `memory/[id]`, `memory/models`, `memory/settings` | Faits mémorisés et réglages par modèle |
| `memory/system` | Message système construit à partir des faits d'un modèle |
| `memory/extract-prompt`, `memory/extract-parse` | Prompt d'extraction des faits, puis lecture de la réponse du modèle |
| `mail/accounts`, `mail/accounts/[id]` | Comptes IMAP (le mot de passe n'est jamais renvoyé) |
| `mail/unread` | Lit les e-mails non lus d'un compte (IMAP, lecture seule) |
| `mail/seen` | Marque des e-mails comme lus (option, désactivée par défaut) |
| `mail/settings` | Modèle du tri, prompt système, option « marquer comme lus » |
| `mail/memory`, `mail/memory/[id]` | Mémoire dédiée au tri des e-mails |
| `mail/feedback` | Notes de l'utilisateur sur les réponses de l'IA |
| `mail/processed` | Historique du tri (en-têtes seulement, aucun extrait du corps) |

## 5. Code serveur (`src/lib/server`)

- `db.ts` : ouverture de `node:sqlite` (WAL, clés étrangères), schéma, migrations successives (`meta.schema_version`), migration des anciennes conversations JSON.
- `storage.ts` : conversations, messages, dossiers.
- `connections.ts` : connexions d'extinction (validation des URL, jeton jamais renvoyé au navigateur).
- `memory.ts` : faits par modèle, réglages, construction du message système, prompt et lecture de l'extraction.
- `mail.ts` : comptes, mémoire et historique du tri, client IMAP minimal en lecture seule (`node:net` et `node:tls`).
- `http.ts` : réponses JSON, contrôle d'origine, validations d'entrées.
- `config.ts` : variables `.env` de dev (`SHUTDOWN_URL`, `SHUTDOWN_METHOD`, `SHUTDOWN_TOKEN`) qui préremplissent la première connexion. Jamais lues en bureau, jamais via `import.meta.env`.

## 6. Base SQLite (`data/app.db`)

Tables :

- `conversations`, `messages` : discussion (rôle `user` ou `assistant`, texte, raisonnement `thinking`, modèle). Colonnes utiles de `conversations` : `folder_id`, `think`, `pinned`, `connection_id`, `use_memory`, `learn_memory`.
- `folders` : dossiers (nom, `color`, `icon`).
- `connections` : connexions d'extinction à distance.
- `memory_facts`, `memory_settings` : mémoire par nom de modèle.
- `mail_accounts`, `mail_settings` (une ligne : modèle, prompt système, `mark_seen`), `mail_memory`, `mail_feedback`, `mail_processed` : e-mails.
- `meta` : `schema_version`.

Les migrations sont dans `db.ts`, idempotentes, dans une transaction. Toute évolution du schéma s'ajoute à la suite et incrémente `schema_version`.

## 7. Code navigateur (`src/lib/client`)

Pas de framework. Le balisage est dans `src/components` et se cible par attributs `data-*`.

`src/components/Animal.astro` affiche un animal low-poly décoratif (SVG serveur, `currentColor`, `aria-hidden`) à partir de `src/lib/animals.js` ; chaque animal est responsable d'une zone (voir « Animaux » dans `CLAUDE.md`).

- **Chat** : `app.js` (orchestration), `conversations.js` (routes conversations et dossiers), `sidebar.js`, `model-picker.js`, `model-settings.js`, `markdown.js` (marked + DOMPurify), `dialog.js`, `icons.js`.
- **Moteur et matériel** : `engine.js` (commandes `engine_*`, événements, file d'attente de génération), `hardware.js` (RAM, GPU, estimation de ce qu'un modèle peut faire).
- **Hugging Face** : `hf.js`, `hf-browser.js` (fenêtre « Ajouter un modèle »), `hf-settings.js` (jeton).
- **Mémoire** : `memory.js`, `memory-settings.js`.
- **E-mails** : `emails-page.js`, `mail-ai.js` (logique pure : prompt, lecture du verdict, modèles conseillés), `mail-ai-panel.js`.
- **Accès distant** : `remote.js`, `remote-settings.js`, `connexion-page.js`, `connect-state.js`, `machine-role.js`, `server-guard.js`, `server-screen.js`, `new-key.js`, `receiver-shutdown.js`, `tower-shutdown.js`.
- **Extinction** : `connections.js`, `connections-settings.js`, `shutdown-settings.js`, `shutdown.js` (bouton marche/arrêt), `switch-utils.js`.
- **Divers** : `settings.js` (page Paramètres), `theme.js`, `i18n.js`, `update.js` (bouton de mise à jour).

## 8. Internationalisation

`src/i18n/{fr,en}/<espace>.json`, avec les espaces `common`, `chat`, `settings`, `connect`, `mail`, `mailai`. Le nom du fichier est l'espace de noms (`chat.composer.placeholder`). Les clés doivent être identiques en FR et en EN. `src/i18n/index.ts` (serveur) et `src/lib/client/i18n.js` (navigateur) chargent les mêmes dictionnaires. Langue : cookie `lang`, sinon `Accept-Language`, sinon français.

## 9. Code Rust (`src-tauri/src`)

| Module | Rôle |
| --- | --- |
| `lib.rs` | Assemble l'app : plugins (single-instance en premier, fs, shell, opener), commandes, sidecar Node, `uninstall_app` |
| `engine/` | Moteur llama.cpp (crate `llama-cpp-2`) : `worker` (thread dédié), `commands`, `models` (dossier des modèles), `gguf` (lecture de l'en-tête, refus des fichiers annexes), `profiles` (réglages par modèle), `estimate` (mémoire et couches GPU), `types`, `utf8` |
| `hf/` | Catalogue Hugging Face : `api`, `download` (fichier `.part`, reprise par Range), `check` (vérification de l'en-tête GGUF avant téléchargement), `avatars`, `names`, `commands`, `types` |
| `server/` | Mode serveur (la « tour ») : `http` (routeur axum), `auth` (clé d'API, limite de débit), `net` (interfaces, validation de l'adresse), `discovery` (UDP) |
| `remote/` | Mode client (le portable) : relais des commandes vers la tour, flux SSE (`sse`) |
| `calls.rs` | Liste blanche des commandes partagées entre pages, API de la tour et relais |
| `bus.rs` | Bus d'événements interne (moteur, téléchargements), lu par le serveur de la tour |
| `updater.rs` | Vérification et installation des mises à jour |
| `crashlog.rs` | Journaux de diagnostic (`session.log`, rapports de crash) |
| `hardware.rs` | RAM et GPU de la machine |
| `localfile.rs` | Petits fichiers JSON de configuration (écriture atomique) |

Commandes Tauri (`invoke`) :

- Application : `uninstall_app`, `app_check_update`, `app_install_update`, `app_crash_logs`, `app_open_crash_logs`.
- Moteur : `engine_info`, `engine_list_models`, `engine_status`, `engine_load`, `engine_unload`, `engine_generate`, `engine_stop`, `engine_delete_model`, `engine_get_profile`, `engine_set_profile`, `engine_reset_profile`, `engine_estimate`.
- Hugging Face : `hf_search`, `hf_list_files`, `hf_download`, `hf_pause`, `hf_resume`, `hf_cancel`, `hf_list_downloads`, `hf_check_file`, `hf_token_status`, `hf_set_token`, `hf_avatars`.
- Matériel : `system_hardware`.
- Serveur : `server_get_config`, `server_interfaces`, `server_generate_key`, `server_delete`, `server_get_shutdown`, `server_set_shutdown`, `server_start`, `server_stop`.
- Client distant : `remote_get_config`, `remote_set_config`, `remote_test`, `remote_discover`, `remote_state`, `remote_shutdown_info`.

Chaque commande doit être déclarée dans trois endroits : `lib.rs` (`generate_handler!`), `build.rs` (liste du manifeste, qui génère `allow-<nom>`) et `capabilities/default.json`.

Événements Tauri : `engine://token`, `engine://status`, `hf://download`, `hf://download-removed`, `server://state`, `remote://state`, `app-update-progress`.

## 10. Flux principaux

### Chat et streaming

1. La page charge la conversation par `/api/conversations/[id]`.
2. `app.js` assemble les messages (message système de mémoire si activé, historique) et appelle `engine.js`.
3. `engine.js` met la génération dans une file (une seule à la fois), écoute `engine://token` et appelle `engine_generate`.
4. Le thread `worker` charge le modèle si besoin et envoie les jetons, découpés en UTF-8 valide (`utf8.rs`).
5. Le navigateur sépare le raisonnement `<think>…</think>` de la réponse, rend le Markdown (DOMPurify), puis enregistre les messages par l'API conversations.

### Mémoire

- Les faits sont stockés par nom de modèle. Chaque conversation a deux options : utiliser la mémoire (`use_memory`) et apprendre (`learn_memory`).
- Utilisation : `/api/memory/system` renvoie le message système à placer en tête.
- Apprentissage : `extract-prompt` fabrique le prompt, le modèle local répond, `extract-parse` lit les faits proposés. L'utilisateur les valide dans la carte de proposition (`MemoryProposal.astro`).

### Mail IA

- `/api/mail/unread` lit les en-têtes et un court extrait des non lus (IMAP, lecture seule ; marquer comme lu est une option).
- `emails-page.js` demande un verdict au modèle local (`mail-ai.js`) : catégorie parmi personnel, pro, notification, pub, indésirable, ou « incertain ».
- Le prompt système est personnalisable. La mémoire dédiée et les notes de l'utilisateur (`mail_feedback`) sont ajoutées au prompt.
- L'historique (`mail_processed`) ne garde que les en-têtes.

### Hugging Face

- `hf_search` et `hf_list_files` interrogent huggingface.co (seul hôte appelé, redirections suivies vers son CDN seulement).
- `hf_check_file` lit l'en-tête GGUF à distance (requêtes Range) et refuse ce que le moteur refuserait.
- `hf_download` écrit dans `<fichier>.part`, reprend par Range, renomme à la fin. Pause, reprise et annulation sont possibles. L'état circule par `hf://download`.
- Le jeton (`hf-token`) sert aux modèles à accès restreint et n'est jamais journalisé.

### Serveur distant (la tour) et récepteur

- Mode serveur : la tour démarre une API HTTP axum (`/api/v1/info`, `/call/{commande}`, `/generate` en flux SSE, `/events` en flux SSE, `/shutdown`). Toutes les routes exigent `Authorization: Bearer <clé>`. Seule l'empreinte SHA-256 de la clé sert à authentifier ; la clé en clair est gardée pour pouvoir être ré-affichée (`server.json`). Les échecs d'authentification sont limités en débit.
- Mode distant (récepteur) : les commandes de la liste blanche (`calls::RELAYED`) et `engine_generate` partent vers la tour ; les événements de la tour sont réémis localement sous les mêmes noms. Les pages ne changent pas.
- Découverte : le récepteur envoie une sonde UDP sur le réseau local ; seule la tour qui reconnaît la clé répond (le récepteur n'a que la clé à saisir).
- Tant que le serveur tourne, `server-guard.js` garde la fenêtre sur `/serveur`.
- Le tunnel WireGuard chiffre les échanges (voir [wireguard.md](wireguard.md)).

### Extinction à distance

Une connexion (table `connections`) décrit une URL, une méthode (GET ou POST) et un jeton. Le bouton marche/arrêt de l'en-tête ouvre la confirmation puis appelle `/api/shutdown`. Une tour peut publier sa propre extinction (`server_set_shutdown`), que le récepteur copie en connexion locale.

### Mise à jour

`updater.rs` compare la version installée à la dernière release GitHub (`Pierre-ML/Lucania`), télécharge `Lucania-Update.exe` dans `%TEMP%`, arrête le moteur puis `node.exe`, lance l'updater avec `/LUCANIA_WAITPID=<pid>` et quitte. Détail et précautions dans `CLAUDE.md` (section Installateur).

## 11. Build et publication

- `scripts/build-desktop.mjs` (lancé par `beforeBuildCommand`) : build Astro avec `LUCANIA_DESKTOP=1`, copie vers `src-tauri/resources/app`, neutralisation des chemins absolus, scan anti-fuite (`.env`, IP, chemins utilisateur), copie de `node.exe` en sidecar, auto-test.
- `scripts/build-updater.mjs` : recompile le même script NSIS avec `LUCANIA_UPDATER` pour produire l'exe de mise à jour.
- `scripts/name-installers.mjs` : copie les deux exe sous des noms fixes dans `bundle/release/`.
- `scripts/copy-cuda-dlls.mjs` : copie les DLL CUDA pour la variante GPU (`tauri.cuda.conf.json`).
- `scripts/set-version.mjs` : met la version à jour dans tous les fichiers qui la portent.
- `.github/workflows/build.yml` : sur `main`, lit la version dans `tauri.conf.json`, échoue si les fichiers divergent, lance `npm run desktop:build` et publie la release `vX.Y.Z` (sans rien publier si le tag existe déjà).
