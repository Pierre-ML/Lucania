<img src="src/assets/logo/loup-blanc.svg" width="72" alt="Lucania">

## App Windows

Téléchargez l'installeur `.exe` dans les [Releases](https://github.com/Pierre-ML/Lucania/releases/latest), puis lancez-le.

## Windows app

Download the `.exe` installer from the [Releases](https://github.com/Pierre-ML/Lucania/releases/latest) page and run it.

# Lucania

Interface de chat web locale, dans le style de Claude.ai, pour vos modèles Ollama.

[Français](#français) · [English](#english)

---

## Français

Lucania est une interface de chat qui tourne sur votre machine et dialogue avec un ou plusieurs serveurs Ollama, en local ou à distance via un VPN WireGuard.

### Fonctionnalités

- Streaming des réponses en direct
- Mode réflexion (think) activable
- Conversations persistantes (SQLite), dossiers, épinglage, renommage
- Rendu Markdown
- Plusieurs connexions : Ollama sur cet ordinateur ou serveur distant via WireGuard
- Page Paramètres : test de connexion, détection automatique des modèles installés, ajout manuel de modèles
- Extinction à distance d'un serveur (optionnelle, désactivée par défaut)
- Thèmes (Lucania, clair, sombre, Nord, Dracula, etc., ou suivi du système) et langues français / anglais

### Prérequis

- Node.js 22.12 ou plus (24 recommandé)
- Ollama installé localement, OU un serveur Ollama joignable via un VPN

### Installation

```sh
git clone <url-du-depot> lucania
cd lucania
npm install
npm run dev
```

Ouvrez ensuite http://localhost:4748.

### Premier lancement

Une connexion « Ollama sur cet ordinateur » est créée automatiquement. Allez dans **Paramètres** pour ajouter, modifier ou tester d'autres serveurs.

### Serveur distant via WireGuard

Installez le client WireGuard officiel sur les deux machines, créez le tunnel, configurez Ollama pour écouter sur le réseau du tunnel, puis ajoutez dans Paramètres une connexion « Serveur distant via WireGuard » avec l'URL du serveur (par exemple `http://10.0.0.2:11434`). Guide détaillé : [docs/wireguard.md](docs/wireguard.md).

### Configuration avancée (.env)

Optionnelle. Le fichier `.env` sert uniquement à pré-remplir la première connexion au premier lancement ; ensuite, tout se règle dans Paramètres. Copiez `.env.example` en `.env` et adaptez-le.

### Données et confidentialité

Tout reste local : les conversations sont stockées dans `data/app.db` (SQLite), rien n'est envoyé dans le cloud. N'exposez ni l'application ni Ollama sur Internet.

### Extinction à distance

Fonction optionnelle, à activer dans les paramètres. Le serveur distant fait tourner un petit listener HTTP protégé par un token ; Lucania lui envoie une requête pour l'éteindre. Désactivée par défaut.

### Lancement rapide sous Windows

Double-cliquez sur `scripts/start-windows.vbs` : il lance le serveur de développement en arrière-plan puis ouvre http://localhost:4748.

### Scripts npm

| Commande | Rôle |
| --- | --- |
| `npm run dev` | Serveur de développement (port 4748) |
| `npm run build` | Build de production |
| `npm run preview` | Prévisualiser le build |
| `npm run check` | Vérification des types |

### Structure du projet

```
src/
  pages/          Pages de l'application
    api/          Routes d'API
  components/     Composants
  lib/
    client/       Code côté navigateur
    server/       Code côté serveur (SQLite, Ollama)
data/             Base SQLite locale (ignorée par git)
docs/             Documentation
scripts/          Scripts utilitaires
```

### Licence

MIT, voir [LICENSE](LICENSE).

---

## English

Lucania is a local web chat interface, Claude.ai-style, for Ollama models. It runs on your machine and talks to one or more Ollama servers, local or remote through a WireGuard VPN.

### Features

- Live response streaming
- Optional reasoning (think) mode
- Persistent conversations (SQLite), folders, pinning, renaming
- Markdown rendering
- Multiple connections: Ollama on this computer or a remote server over WireGuard
- Settings page: connection test, automatic detection of installed models, manual model entry
- Optional remote shutdown of a server (disabled by default)
- Themes (Lucania, light, dark, Nord, Dracula, etc., or follow the system) and French / English languages

### Requirements

- Node.js 22.12 or newer (24 recommended)
- Ollama installed locally, OR an Ollama server reachable through a VPN

### Installation

```sh
git clone <repository-url> lucania
cd lucania
npm install
npm run dev
```

Then open http://localhost:4748.

### First launch

An "Ollama on this computer" connection is created automatically. Go to **Settings** (Paramètres) to add, edit or test other servers.

### Remote server over WireGuard

Install the official WireGuard client on both machines, create the tunnel, set Ollama to listen on the tunnel network, then add a "Remote server via WireGuard" connection in Settings with the server URL (for example `http://10.0.0.2:11434`). Detailed guide: [docs/wireguard.md](docs/wireguard.md).

### Advanced configuration (.env)

Optional. The `.env` file only pre-fills the first connection on first launch; everything else is configured in Settings. Copy `.env.example` to `.env` and adjust it.

### Data and privacy

Everything stays local: conversations are stored in `data/app.db` (SQLite), nothing is sent to the cloud. Do not expose the app or Ollama to the Internet.

### Remote shutdown

Optional feature, enabled in the settings. The remote server runs a small HTTP listener protected by a token; Lucania sends it a request to shut it down. Disabled by default.

### Quick start on Windows

Double-click `scripts/start-windows.vbs`: it starts the dev server in the background and opens http://localhost:4748.

### npm scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server (port 4748) |
| `npm run build` | Production build |
| `npm run preview` | Preview the build |
| `npm run check` | Type checking |

### Project structure

```
src/
  pages/          App pages
    api/          API routes
  components/     Components
  lib/
    client/       Browser-side code
    server/       Server-side code (SQLite, Ollama)
data/             Local SQLite database (git-ignored)
docs/             Documentation
scripts/          Helper scripts
```

### License

MIT, see [LICENSE](LICENSE).
