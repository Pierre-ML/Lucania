# Utiliser un serveur Ollama distant via WireGuard

## Principe

Le PC qui fait tourner Lucania (client) et la machine qui fait tourner Ollama (serveur) sont placés dans un même tunnel WireGuard. Ils se voient alors comme sur un réseau privé (par exemple `10.0.0.1` pour le client et `10.0.0.2` pour le serveur) et Lucania parle à Ollama à travers ce tunnel chiffré. Les adresses de ce guide sont des exemples : utilisez celles de votre propre tunnel.

## 1. Installer WireGuard

Installez le client officiel sur les deux machines : https://www.wireguard.com/install/

## 2. Créer ou importer le tunnel

Créez la configuration du tunnel (clés, adresses, endpoint) selon vos besoins, ou importez le fichier `.conf` fourni par l'administrateur du serveur. Activez le tunnel des deux côtés et vérifiez que les machines se joignent (`ping 10.0.0.2`).

## 3. Côté serveur : ouvrir Ollama au tunnel

Par défaut Ollama n'écoute que sur `127.0.0.1`. Il faut lui demander d'écouter sur les interfaces réseau.

- **Windows** : créez la variable d'environnement système `OLLAMA_HOST` avec la valeur `0.0.0.0`, puis quittez et redémarrez Ollama.
- **Linux (systemd)** : lancez `sudo systemctl edit ollama` et ajoutez :

  ```ini
  [Service]
  Environment="OLLAMA_HOST=0.0.0.0"
  ```

  puis `sudo systemctl daemon-reload && sudo systemctl restart ollama`.

### Pare-feu

N'autorisez le port **11434** que depuis l'interface ou la plage d'adresses du tunnel (par exemple `10.0.0.0/24`). Ne l'ouvrez jamais à tout le monde.

## 4. Vérifier depuis le client

```sh
curl http://10.0.0.2:11434/api/tags
```

Une réponse JSON listant les modèles confirme que tout fonctionne.

## 5. Configurer Lucania

**Paramètres** → **Ajouter une connexion** → **Serveur distant via WireGuard** → saisissez l'URL (`http://10.0.0.2:11434`) → **Tester**. Les modèles installés sont détectés automatiquement.

## Dépannage

- **Délai dépassé** : le tunnel est inactif ou le pare-feu bloque le port 11434.
- **Connexion refusée** : `OLLAMA_HOST` n'est pas réglé (ou Ollama n'a pas été redémarré).

## Sécurité

N'exposez jamais le port 11434 sur Internet : Ollama n'a pas d'authentification. Le tunnel WireGuard est la seule porte d'entrée.

---

# English summary

**Principle**: put the machine running Lucania and the machine running Ollama in the same WireGuard tunnel (example addresses `10.0.0.1` and `10.0.0.2`).

1. Install the official WireGuard client on both machines and bring the tunnel up.
2. On the server, make Ollama listen on all interfaces: on Windows set the system environment variable `OLLAMA_HOST=0.0.0.0` and restart Ollama; on Linux run `sudo systemctl edit ollama` and add `Environment="OLLAMA_HOST=0.0.0.0"`, then restart the service.
3. Firewall: allow port 11434 only from the tunnel interface/range.
4. From the client, check: `curl http://10.0.0.2:11434/api/tags`.
5. In Lucania: Settings, Add a connection, Remote server via WireGuard, enter the URL, Test.

**Troubleshooting**: timeout means the tunnel is down or the firewall blocks the port; connection refused means `OLLAMA_HOST` is not set.

**Security**: never expose port 11434 to the Internet.
