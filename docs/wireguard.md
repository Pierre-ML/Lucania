# Utiliser une autre machine avec Lucania (mode serveur et WireGuard)

## 1. Principe

Une machine puissante avec GPU, la « tour », fait tourner le moteur. Un portable se connecte à elle et s'en sert comme moteur.

- La tour lance Lucania en **mode serveur**.
- Le portable passe en **mode distant** et envoie tout à la tour.
- Un tunnel WireGuard relie les deux machines. L'API de Lucania parle en HTTP clair : c'est le tunnel qui chiffre les échanges.

Les adresses de ce guide sont des exemples : tour `10.0.0.1`, portable `10.0.0.2`. Utilisez celles de votre tunnel.

## 2. Créer le tunnel WireGuard

### 2.1 Installer WireGuard

Installez le client officiel sur les deux machines : https://www.wireguard.com/install/

### 2.2 Configuration de la tour

Créez un tunnel vide dans WireGuard (il génère la clé privée), puis complétez-le :

```ini
[Interface]
PrivateKey = <clé privée de la tour>
Address = 10.0.0.1/24
ListenPort = 51820

[Peer]
PublicKey = <clé publique du portable>
AllowedIPs = 10.0.0.2/32
```

### 2.3 Configuration du portable

```ini
[Interface]
PrivateKey = <clé privée du portable>
Address = 10.0.0.2/24

[Peer]
PublicKey = <clé publique de la tour>
Endpoint = <IP publique ou nom DDNS de la tour>:51820
AllowedIPs = 10.0.0.1/32
PersistentKeepalive = 25
```

`AllowedIPs = 10.0.0.1/32` fait passer dans le tunnel uniquement le trafic vers la tour. Le reste de votre connexion n'est pas modifié.

### 2.4 Redirection de port

- Depuis l'extérieur : redirigez le port UDP 51820 de votre box vers la tour.
- En réseau local seul : aucune redirection n'est nécessaire. Mettez l'adresse locale de la tour dans `Endpoint`.

### 2.5 Vérifier le tunnel

Activez le tunnel des deux côtés, puis depuis le portable :

```sh
ping 10.0.0.1
```

## 3. Côté tour : activer le mode serveur

Dans Lucania, ouvrez **Paramètres › Accès distant › Partager cette machine**.

1. Choisissez l'interface réseau. L'interface WireGuard est détectée et proposée en premier.
2. Choisissez le port (4750 par défaut).
3. Cliquez sur **Générer une nouvelle clé**. La clé d'API (préfixe `luc_`) n'est affichée **qu'une seule fois** : copiez-la.
4. Cliquez sur **Activer le mode serveur**.

L'app passe en plein écran avec un seul bouton, **Arrêter le mode serveur**. Le mode serveur redémarre tout seul si Lucania redémarre.

« Toutes les interfaces (0.0.0.0) » est possible mais déconseillé : le port devient joignable depuis tous vos réseaux. Une confirmation explicite est demandée.

### 3.1 Pare-feu Windows

À la première activation, Windows peut demander d'autoriser Lucania. Acceptez pour les **réseaux privés** seulement.

Variante plus stricte : une règle entrante limitée au port et aux adresses du tunnel. En PowerShell administrateur :

```powershell
New-NetFirewallRule -DisplayName "Lucania (WireGuard)" -Direction Inbound -Protocol TCP -LocalPort 4750 -LocalAddress 10.0.0.1 -RemoteAddress 10.0.0.2 -Action Allow
```

Adaptez les adresses et le port.

## 4. Côté portable : passer en mode distant

Dans **Paramètres › Accès distant › Utiliser une autre machine** :

1. Choisissez **Distant**.
2. Saisissez l'adresse : `http://10.0.0.1:4750`.
3. Collez la clé d'API.
4. Cliquez sur **Tester la connexion**. Le test affiche la latence, la version et le GPU de la tour.
5. Cliquez sur **Enregistrer**. La page se recharge.

Ensuite tout passe par la tour :

- le chat ;
- les modèles installés et les réglages par modèle ;
- les téléchargements Hugging Face (les fichiers arrivent sur la tour) ;
- « Mon matériel » et les badges de compatibilité, qui décrivent le matériel de la tour.

Vous pouvez revenir en **Local** à tout moment.

## 5. Pastille marche/arrêt

La pastille de l'en-tête indique l'état de la tour.

| Couleur | Signification |
| --- | --- |
| Gris | Tour injoignable |
| Orange | Tour joignable, aucun modèle chargé |
| Vert | Modèle prêt |

Un clic éteint la tour, via la connexion d'extinction configurée dans **Paramètres › Connexions**. Il n'y a pas de Wake-on-LAN : la tour doit être allumée pour être utilisée.

## 6. Sécurité

- Ne jamais exposer le port de Lucania sur Internet ni sur un réseau non fiable. Seul le tunnel WireGuard doit y donner accès.
- Chaque requête exige la clé d'API (en-tête Bearer). Elle est comparée en temps constant.
- Après 5 échecs d'authentification en 1 minute, l'adresse IP est bloquée 5 minutes.
- Régénérer la clé invalide immédiatement l'ancienne. Mettez ensuite la nouvelle sur le portable.

## 7. Dépannage

- **Tour injoignable** : vérifiez que le tunnel est actif des deux côtés, que la tour est allumée et pas en veille, que le mode serveur est activé, que le pare-feu laisse passer le port, et que l'IP et le port saisis sont les bons.
- **Clé d'API refusée** : la clé a été régénérée ou mal copiée. Générez-en une nouvelle sur la tour et recollez-la.
- **Trop de tentatives** : attendez 5 minutes, puis réessayez avec la bonne clé.
- **Port déjà utilisé** : un autre programme occupe le port. Choisissez-en un autre sur la tour et mettez-le à jour sur le portable.
- **Tour en veille** : désactivez la veille de la tour. Sans Wake-on-LAN, une tour endormie reste injoignable.

---

# English summary

**Principle**: a powerful PC (the tower) runs Lucania in server mode. A laptop switches to remote mode and uses the tower as its engine. A WireGuard tunnel encrypts the traffic, since the API speaks plain HTTP.

1. Install WireGuard on both machines. Tower: `Address = 10.0.0.1/24`, `ListenPort = 51820`. Laptop: `Address = 10.0.0.2/24`, `Endpoint` to the tower, `AllowedIPs = 10.0.0.1/32`, `PersistentKeepalive = 25`. Forward UDP 51820 on your router only for access from outside. Check with `ping 10.0.0.1`.
2. Tower: Settings, Remote access, Share this machine. Pick the interface, the port (default 4750), generate a key (shown once, prefix `luc_`), then enable server mode. Allow Lucania in the Windows firewall on private networks only, or add a rule limited to the tunnel addresses.
3. Laptop: Settings, Remote access, Use another machine, Remote. Enter `http://10.0.0.1:4750`, paste the key, test, save. Chat, models, Hugging Face downloads and hardware badges now use the tower. Switch back to Local at any time.
4. Power indicator: grey means unreachable, orange means reachable with no model loaded, green means a model is ready. A click shuts the tower down through the shutdown connection (no Wake-on-LAN).

**Security**: never expose the port to the Internet. Constant-time Bearer key check; 5 failures in 1 minute block the IP for 5 minutes; regenerating the key invalidates the old one.

**Troubleshooting**: unreachable tower (tunnel, power or sleep, server mode, firewall, IP or port), key refused (regenerated or mis-copied), too many attempts (wait 5 minutes), port in use (pick another).
