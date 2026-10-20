<div align="center"><img src="src/assets/logo/loup.svg" alt="Lucania" width="96" /><h1>Lucania</h1><p>Une interface de chat locale, façon Claude.ai, pour vos modèles GGUF.<br/>A local, Claude.ai-style chat interface for your GGUF models.</p>
<a href="https://github.com/Pierre-ML/Lucania/releases/latest/download/Lucania-Setup.exe"><b>⬇ Télécharger pour Windows · Download for Windows</b></a><br/><sub>setup pour installer · update pour mettre à jour / setup to install · update to update · <a href="https://github.com/Pierre-ML/Lucania/releases/latest">releases</a></sub></div>

<p align="center">
<a href="https://github.com/Pierre-ML/Lucania/releases/latest"><img src="https://img.shields.io/github/v/release/Pierre-ML/Lucania" alt="Dernière release" /></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-green" alt="MIT" /></a>
<img src="https://img.shields.io/badge/plateforme-Windows-blue" alt="Windows" />
<a href="https://github.com/Pierre-ML/Lucania/releases"><img src="https://img.shields.io/github/downloads/Pierre-ML/Lucania/total" alt="Téléchargements" /></a>
</p>

<p align="center"><a href="#français">Français</a> · <a href="#english">English</a></p>

<!-- TODO: capture d'écran -->

---

# Français

## Présentation

Lucania est une interface de chat **locale**. Elle embarque un moteur [llama.cpp](https://github.com/ggml-org/llama.cpp) qui exécute directement vos modèles GGUF, sans serveur externe. Elle existe en application de bureau Windows (installateur `.exe`).

Vos conversations restent sur votre machine. Rien n'est envoyé dans le cloud.

## Fonctionnalités

- ⚡ Réponses en streaming
- 📝 Rendu Markdown
- 🧠 Mode réflexion (`think`), activable par conversation
- 📁 Conversations : dossiers (couleur et icône), glisser-déposer, épinglage, renommage, groupes par date
- 🦙 Moteur llama.cpp intégré : modèles GGUF, CPU ou GPU (CUDA)
- 🤗 Téléchargement de modèles depuis Hugging Face (recherche, vérification du fichier, pause et reprise, jeton pour les modèles à accès restreint)
- 🎛️ Réglages par modèle : contexte, couches GPU, échantillonnage, prompt système, avec estimation de la mémoire vidéo
- 🧩 Mémoire par modèle : faits retenus à la main ou proposés par le modèle, activables par conversation
- ✉️ Tri des e-mails par IA : vos messages non lus (IMAP, lecture seule) sont classés par un modèle local
- 🖥️ Serveur et accès distant : une machine puissante (la « tour ») partage son moteur avec un portable, avec découverte sur le réseau local ([guide WireGuard](docs/wireguard.md))
- ⏻ Extinction à distance d'un serveur
- 🔄 Mise à jour depuis l'application
- 🎨 13 thèmes (dont « Système »)
- 🌍 Interface en français et en anglais
- 💾 Données stockées localement (SQLite)

## Installation

1. Pour une première installation, téléchargez [`Lucania-Setup.exe`](https://github.com/Pierre-ML/Lucania/releases/latest/download/Lucania-Setup.exe) (lien direct, dernière release).
2. Lancez l'installateur. Lucania s'installe pour votre compte Windows, dans `%LOCALAPPDATA%\Programs\Lucania`. Aucune autorisation administrateur n'est demandée.

Prérequis : Windows 10 ou 11 (64 bits).

> **Antivirus.** L'exécutable n'est pas encore signé. Windows SmartScreen ou certains antivirus peuvent donc l'analyser ou afficher un avertissement.

Le nom du fichier ne change jamais : une seule exception dans votre antivirus suffit pour toutes les versions.

## Premiers pas

1. Ajoutez un modèle : soit avec le bouton « Ajouter un modèle » (recherche et téléchargement depuis Hugging Face), soit en copiant des fichiers `.gguf` dans `%LOCALAPPDATA%\com.lucania.desktop\models` (les sous-dossiers sont acceptés).
2. Ouvrez Lucania, choisissez un modèle dans le chat et écrivez.

## Accélération GPU

La release GitHub est compilée pour le CPU. Pour le GPU NVIDIA, compilez vous-même la variante CUDA (voir Développement). Elle nécessite CMake, LLVM et le CUDA Toolkit 12.8 ou plus récent.

## Mise à jour

Depuis l'application : le bouton de mise à jour (en-tête) vérifie la dernière release GitHub, télécharge l'updater et l'installe après confirmation.

À la main : téléchargez [`Lucania-Update.exe`](https://github.com/Pierre-ML/Lucania/releases/latest/download/Lucania-Update.exe) (lien direct, dernière release) et lancez-le.

Vos conversations sont conservées. L'updater ferme Lucania si nécessaire.

Ancienne version installée dans `C:\Program Files\Lucania` ? L'update ne la met pas à jour. Lancez le setup une fois : il vous prévient, puis installe au nouvel emplacement. Vos conversations sont conservées. Pour supprimer l'ancienne version, supprimez simplement le dossier `C:\Program Files\Lucania` (Windows demande une autorisation). ⚠️ Ne la désinstallez **pas** depuis Paramètres > Applications : l'ancien désinstallateur effacerait aussi vos conversations, partagées avec la nouvelle installation.

Repartir de zéro : désinstallez Lucania depuis les Paramètres Windows (cela supprime aussi vos conversations), puis relancez le setup.

## Développement

Prérequis : Node 24 (le projet utilise `node:sqlite` ; `engines` exige au minimum 22.12). Pour l'app de bureau : Rust 1.90 ou plus (MSVC) et les Visual Studio Build Tools.

| Commande | Rôle |
| --- | --- |
| `npm install` | Installer les dépendances |
| `npm run dev` | Serveur web de dev sur http://localhost:4748 |
| `npm run desktop:dev` | App de bureau en dev (nécessaire pour utiliser le chat) |
| `npm run tauri:cuda` | App de bureau en dev avec le moteur CUDA |
| `npm run desktop:build` | Produire les deux exe Windows (`Lucania-Setup.exe` et `Lucania-Update.exe`, dans `src-tauri/target/release/bundle/release/`), moteur CPU |
| `npm run desktop:build:cuda` | Idem avec le moteur CUDA |
| `npm run check` | Vérifier les types |
| `npm run version:set X.Y.Z` | Mettre à jour la version partout |

`npm run dev` seul affiche l'interface mais le chat n'y fonctionne pas : le moteur est dans l'app de bureau, il faut `npm run desktop:dev`.

Version : source unique dans `src-tauri/tauri.conf.json`, identique dans `package.json`, `package-lock.json` et `src-tauri/Cargo.toml`. Le workflow GitHub (`.github/workflows/build.yml`) construit sous Windows et publie la release `vX.Y.Z`.

En développement, un fichier `.env` facultatif (non versionné) peut préremplir la première connexion d'extinction à distance avec `SHUTDOWN_URL`, `SHUTDOWN_METHOD` et `SHUTDOWN_TOKEN`. L'app distribuée démarre vierge et se configure dans Paramètres.

## Stack

Astro 7 (SSR, adapter Node) · JavaScript vanilla · Tailwind CSS v4 · daisyUI 5 · SQLite (`node:sqlite`) · Tauri v2 · Rust (llama.cpp via `llama-cpp-2`, `reqwest`, `axum`).

## Structure

- `src/pages` : pages (chat, e-mails, paramètres, connexion, serveur) et routes `api/**`.
- `src/lib/server` : base SQLite, conversations, mémoire, e-mails, connexions.
- `src/lib/client` : JavaScript du navigateur.
- `src/components` : composants Astro. `src/i18n` : textes FR et EN.
- `src-tauri` : application Tauri (moteur llama.cpp, Hugging Face, mode serveur et distant, mise à jour, installateur NSIS).
- `scripts` : build du bureau, des installateurs, gestion de la version.
- `docs` : [architecture](docs/ARCHITECTURE.md) et [guide WireGuard](docs/wireguard.md).

## Confidentialité

Vos conversations restent sur votre machine. Lucania ne contacte que :

- huggingface.co, quand vous cherchez ou téléchargez un modèle ;
- GitHub, pour vérifier et télécharger les mises à jour ;
- votre fournisseur de messagerie, si vous utilisez le tri des e-mails ;
- la tour que vous avez configurée, en mode distant.

Les données sont dans une base SQLite :

- en dev : `data/app.db` ;
- dans l'app de bureau : `%APPDATA%\com.lucania.desktop\data\app.db` (le cache est dans `%LOCALAPPDATA%\com.lucania.desktop`). Ces chemins ne changent pas.

## Licence

[MIT](LICENSE). Dépôt : https://github.com/Pierre-ML/Lucania

---

# English

## Overview

Lucania is a **local** chat interface. It embeds a [llama.cpp](https://github.com/ggml-org/llama.cpp) engine that runs your GGUF models directly, with no external server. It comes as a Windows desktop app (`.exe` installer).

Your conversations stay on your machine. Nothing is sent to the cloud.

## Features

- ⚡ Streaming responses
- 📝 Markdown rendering
- 🧠 Thinking mode (`think`), toggled per conversation
- 📁 Conversations: folders (color and icon), drag and drop, pinning, renaming, date groups
- 🦙 Built-in llama.cpp engine: GGUF models, CPU or GPU (CUDA)
- 🤗 Model download from Hugging Face (search, file check, pause and resume, token for gated models)
- 🎛️ Per-model settings: context, GPU layers, sampling, system prompt, with a video memory estimate
- 🧩 Per-model memory: facts kept by hand or suggested by the model, switchable per conversation
- ✉️ AI email sorting: your unread messages (IMAP, read-only) are classified by a local model
- 🖥️ Server and remote access: a powerful machine (the "tower") shares its engine with a laptop, with discovery on the local network ([WireGuard guide](docs/wireguard.md))
- ⏻ Remote shutdown of a server
- 🔄 In-app update
- 🎨 13 themes (including "System")
- 🌍 French and English interface
- 💾 Data stored locally (SQLite)

## Installation

1. For a first install, download [`Lucania-Setup.exe`](https://github.com/Pierre-ML/Lucania/releases/latest/download/Lucania-Setup.exe) (direct link, latest release).
2. Run the installer. Lucania installs for your Windows account, in `%LOCALAPPDATA%\Programs\Lucania`. No administrator permission is asked.

Requirements: Windows 10 or 11 (64-bit).

> **Antivirus.** The executable is not signed yet. Windows SmartScreen or some antivirus tools may scan it or show a warning.

The file name never changes: a single exception in your antivirus is enough for all versions.

## Getting started

1. Add a model: either with the "Add a model" button (search and download from Hugging Face), or by copying `.gguf` files into `%LOCALAPPDATA%\com.lucania.desktop\models` (subfolders are accepted).
2. Open Lucania, pick a model in the chat and start typing.

## GPU acceleration

The GitHub release is built for CPU. For an NVIDIA GPU, build the CUDA variant yourself (see Development). It requires CMake, LLVM and CUDA Toolkit 12.8 or newer.

## Updating

From the app: the update button (header) checks the latest GitHub release, downloads the updater and installs it after confirmation.

By hand: download [`Lucania-Update.exe`](https://github.com/Pierre-ML/Lucania/releases/latest/download/Lucania-Update.exe) (direct link, latest release) and run it.

Your conversations are kept. The updater closes Lucania if needed.

Old version installed in `C:\Program Files\Lucania`? The update does not touch it. Run the setup once: it warns you, then installs in the new location. Your conversations are kept. To remove the old version, simply delete the `C:\Program Files\Lucania` folder (Windows asks for permission). ⚠️ Do **not** uninstall it from Settings > Apps: the old uninstaller would also erase your conversations, which are shared with the new installation.

Start from scratch: uninstall Lucania from Windows Settings (this also deletes your conversations), then run the setup again.

## Development

Requirements: Node 24 (the project uses `node:sqlite`; `engines` requires 22.12 at minimum). For the desktop app: Rust 1.90 or newer (MSVC) and Visual Studio Build Tools.

| Command | Purpose |
| --- | --- |
| `npm install` | Install dependencies |
| `npm run dev` | Dev web server on http://localhost:4748 |
| `npm run desktop:dev` | Desktop app in dev (required to use the chat) |
| `npm run tauri:cuda` | Desktop app in dev with the CUDA engine |
| `npm run desktop:build` | Build both Windows exes (`Lucania-Setup.exe` and `Lucania-Update.exe`, in `src-tauri/target/release/bundle/release/`), CPU engine |
| `npm run desktop:build:cuda` | Same with the CUDA engine |
| `npm run check` | Type check |
| `npm run version:set X.Y.Z` | Set the version everywhere |

`npm run dev` alone shows the interface but chat does not work there: the engine lives in the desktop app, use `npm run desktop:dev`.

Version: single source in `src-tauri/tauri.conf.json`, identical in `package.json`, `package-lock.json` and `src-tauri/Cargo.toml`. The GitHub workflow (`.github/workflows/build.yml`) builds on Windows and publishes the `vX.Y.Z` release.

In development, an optional `.env` file (not versioned) can prefill the first remote-shutdown connection with `SHUTDOWN_URL`, `SHUTDOWN_METHOD` and `SHUTDOWN_TOKEN`. The distributed app starts blank and is configured in Settings.

## Stack

Astro 7 (SSR, Node adapter) · vanilla JavaScript · Tailwind CSS v4 · daisyUI 5 · SQLite (`node:sqlite`) · Tauri v2 · Rust (llama.cpp via `llama-cpp-2`, `reqwest`, `axum`).

## Structure

- `src/pages`: pages (chat, emails, settings, connection, server) and `api/**` routes.
- `src/lib/server`: SQLite database, conversations, memory, emails, connections.
- `src/lib/client`: browser JavaScript.
- `src/components`: Astro components. `src/i18n`: FR and EN texts.
- `src-tauri`: Tauri app (llama.cpp engine, Hugging Face, server and remote modes, update, NSIS installer).
- `scripts`: desktop and installer builds, version management.
- `docs`: [architecture](docs/ARCHITECTURE.md) and [WireGuard guide](docs/wireguard.md).

## Privacy

Your conversations stay on your machine. Lucania only contacts:

- huggingface.co, when you search or download a model;
- GitHub, to check and download updates;
- your mail provider, if you use email sorting;
- the tower you configured, in remote mode.

Data lives in a SQLite database:

- in dev: `data/app.db`;
- in the desktop app: `%APPDATA%\com.lucania.desktop\data\app.db` (the cache is in `%LOCALAPPDATA%\com.lucania.desktop`). These paths do not change.

## License

[MIT](LICENSE). Repository: https://github.com/Pierre-ML/Lucania
