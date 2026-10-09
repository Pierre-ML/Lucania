<div align="center"><img src="src/assets/logo/loup.svg" alt="Lucania" width="96" /><h1>Lucania</h1><p>Une interface de chat locale, façon Claude.ai, pour vos modèles Ollama.<br/>A local, Claude.ai-style chat interface for your Ollama models.</p>
<a href="https://github.com/Pierre-ML/Lucania/releases/latest"><b>⬇ Télécharger pour Windows · Download for Windows</b></a><br/><sub>setup pour installer · update pour mettre à jour / setup to install · update to update</sub></div>

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

Lucania est une interface de chat **locale** pour les modèles [Ollama](https://ollama.com). Elle existe en application de bureau Windows (installateur `.exe`) et en version web.

Vos conversations restent sur votre machine. Rien n'est envoyé dans le cloud.

## Fonctionnalités

- ⚡ Réponses en streaming
- 📝 Rendu Markdown
- 🧠 Mode réflexion (`think`), activable par conversation
- 📁 Conversations : dossiers (glisser-déposer), épinglage, renommage, groupes par date
- 🔌 Plusieurs connexions Ollama : machine locale ou serveur distant
- 🔒 Serveur distant via un VPN WireGuard que vous gérez
- ⏻ Extinction à distance d'un serveur
- 🎨 13 thèmes
- 🌍 Interface en français et en anglais
- 💾 Données stockées localement (SQLite)

À venir : une mémoire persistante par modèle (en cours de développement).

## Installation

1. Installez [Ollama](https://ollama.com), ou ayez accès à un serveur Ollama.
2. Pour une première installation, téléchargez `Lucania_<version>_x64-setup.exe` depuis la [dernière release](https://github.com/Pierre-ML/Lucania/releases/latest).
3. Lancez l'installateur. Lucania s'installe dans Program Files.

Prérequis : Windows 10 ou 11 (64 bits).

> **Antivirus.** L'exécutable n'est pas encore signé. Windows SmartScreen ou certains antivirus peuvent donc l'analyser ou afficher un avertissement.

## Premiers pas

1. Ouvrez **Paramètres**.
2. Ajoutez une **connexion** Ollama (la machine locale ou l'adresse d'un serveur).
3. Revenez au chat, choisissez un modèle et écrivez.

## Serveur distant (WireGuard)

Pour utiliser un serveur Ollama distant, connectez-vous à lui par un VPN WireGuard que vous gérez, puis ajoutez-le comme connexion. Voir [docs/wireguard.md](docs/wireguard.md).

## Mise à jour

Téléchargez `Lucania_<version>_x64-update.exe` depuis la [dernière release](https://github.com/Pierre-ML/Lucania/releases/latest) et lancez-le.

Vos conversations sont conservées. L'updater ferme Lucania si nécessaire.

Repartir de zéro : désinstallez Lucania depuis les Paramètres Windows (cela supprime aussi vos conversations), puis relancez le setup.

## Développement

Prérequis : Node 24 (le projet utilise `node:sqlite` ; `engines` exige au minimum 22.12). Pour l'app de bureau : Rust (MSVC) et les Visual Studio Build Tools.

| Commande | Rôle |
| --- | --- |
| `npm install` | Installer les dépendances |
| `npm run dev` | Serveur web de dev sur http://localhost:4748 |
| `npm run tauri dev` | App de bureau en dev |
| `npm run desktop:build` | Produire les deux exe Windows (setup et update) |
| `npm run check` | Vérifier les types |
| `npm run version:set X.Y.Z` | Mettre à jour la version partout |

En développement, un fichier `.env` facultatif (non versionné) peut préremplir la première connexion avec `OLLAMA_URL`, `OLLAMA_MODELS`, `SHUTDOWN_URL`, `SHUTDOWN_METHOD` et `SHUTDOWN_TOKEN`. L'app distribuée démarre vierge et se configure dans Paramètres.

## Stack

Astro 7 (SSR, adapter Node) · JavaScript vanilla · Tailwind CSS v4 · daisyUI 5 · SQLite (`node:sqlite`) · Tauri v2.

## Confidentialité

Tout est local. Les données sont dans une base SQLite :

- en dev : `data/app.db` ;
- dans l'app de bureau : `%APPDATA%\com.lucania.desktop\data\app.db`.

## Licence

[MIT](LICENSE). Dépôt : https://github.com/Pierre-ML/Lucania

---

# English

## Overview

Lucania is a **local** chat interface for [Ollama](https://ollama.com) models. It comes as a Windows desktop app (`.exe` installer) and as a web version.

Your conversations stay on your machine. Nothing is sent to the cloud.

## Features

- ⚡ Streaming responses
- 📝 Markdown rendering
- 🧠 Thinking mode (`think`), toggled per conversation
- 📁 Conversations: folders (drag and drop), pinning, renaming, date groups
- 🔌 Multiple Ollama connections: local machine or remote server
- 🔒 Remote server through a WireGuard VPN that you manage
- ⏻ Remote shutdown of a server
- 🎨 13 themes
- 🌍 French and English interface
- 💾 Data stored locally (SQLite)

Coming soon: persistent memory per model (in development).

## Installation

1. Install [Ollama](https://ollama.com), or have access to an Ollama server.
2. For a first install, download `Lucania_<version>_x64-setup.exe` from the [latest release](https://github.com/Pierre-ML/Lucania/releases/latest).
3. Run the installer. Lucania installs into Program Files.

Requirements: Windows 10 or 11 (64-bit).

> **Antivirus.** The executable is not signed yet. Windows SmartScreen or some antivirus tools may scan it or show a warning.

## Getting started

1. Open **Settings**.
2. Add an Ollama **connection** (the local machine or a server address).
3. Go back to the chat, pick a model and start typing.

## Remote server (WireGuard)

To use a remote Ollama server, connect to it through a WireGuard VPN that you manage, then add it as a connection. See [docs/wireguard.md](docs/wireguard.md).

## Updating

Download `Lucania_<version>_x64-update.exe` from the [latest release](https://github.com/Pierre-ML/Lucania/releases/latest) and run it.

Your conversations are kept. The updater closes Lucania if needed.

Start from scratch: uninstall Lucania from Windows Settings (this also deletes your conversations), then run the setup again.

## Development

Requirements: Node 24 (the project uses `node:sqlite`; `engines` requires 22.12 at minimum). For the desktop app: Rust (MSVC) and Visual Studio Build Tools.

| Command | Purpose |
| --- | --- |
| `npm install` | Install dependencies |
| `npm run dev` | Dev web server on http://localhost:4748 |
| `npm run tauri dev` | Desktop app in dev |
| `npm run desktop:build` | Build both Windows exes (setup and update) |
| `npm run check` | Type check |
| `npm run version:set X.Y.Z` | Set the version everywhere |

In development, an optional `.env` file (not versioned) can prefill the first connection with `OLLAMA_URL`, `OLLAMA_MODELS`, `SHUTDOWN_URL`, `SHUTDOWN_METHOD` and `SHUTDOWN_TOKEN`. The distributed app starts blank and is configured in Settings.

## Stack

Astro 7 (SSR, Node adapter) · vanilla JavaScript · Tailwind CSS v4 · daisyUI 5 · SQLite (`node:sqlite`) · Tauri v2.

## Privacy

Everything is local. Data lives in a SQLite database:

- in dev: `data/app.db`;
- in the desktop app: `%APPDATA%\com.lucania.desktop\data\app.db`.

## License

[MIT](LICENSE). Repository: https://github.com/Pierre-ML/Lucania
