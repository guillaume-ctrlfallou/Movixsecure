# Installer Movix sur le PC serveur — pas à pas

Durée : **environ 45 minutes**, dont 10 d'attente pendant la compilation.
Ce tuto suppose un PC sous **Ubuntu 22.04 ou 24.04**. Il va de la machine vierge
au film qui se lance sur ton téléphone en 4G.

Pour comprendre ce qui est installé et pourquoi, voir `DEPLOIEMENT.md`.

---

## 0. Ce qu'il te faut avant de commencer

| Quoi | Où | Obligatoire |
|---|---|---|
| Un compte **Tailscale** (gratuit) | https://login.tailscale.com — connexion avec Google, GitHub ou Microsoft | oui |
| Une clé **TMDB** (gratuite) | https://www.themoviedb.org/settings/api → *API Key* (la clé « v3 », une chaîne de 32 caractères, **pas** le « jeton d'accès en lecture ») | oui, sans elle il n'y a pas de catalogue |
| La clé **secrète Supabase** | tableau de bord Supabase → projet `movix-perso` → *Project Settings → API Keys → Secret keys* → copier `sb_secret_…` | non, mais recommandé |

> 🔒 Colle ces clés **uniquement** dans le terminal du serveur. Ne les envoie à
> personne, moi compris, et ne les écris dans aucun fichier du dépôt.

**Conseil connexion :** pour ce test, branche le PC en **câble Ethernet** si tu
peux. Le Wi-Fi marche, mais c'est la première chose à soupçonner si la vidéo
saccade.

---

## 1. Préparer la machine

Ouvre un terminal sur le PC serveur.

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl
```

### Installer Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

**Déconnecte-toi puis reconnecte-toi** (ou redémarre) pour que le groupe
`docker` s'applique, puis vérifie :

```bash
docker run --rm hello-world       # doit afficher « Hello from Docker! »
docker compose version            # doit afficher v2.x
```

### Empêcher la mise en veille

Un serveur qui s'endort ne répond plus. Sur un PC de bureau ou un portable :

```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

**Portable seulement** — pour pouvoir fermer l'écran sans couper le serveur :

```bash
sudo sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/; s/^#\?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
sudo reboot
```

---

## 2. Installer Tailscale

Tailscale crée un réseau privé et chiffré entre tes appareils. **C'est lui qui
permet d'accéder au serveur de n'importe où, sans ouvrir de port sur ta box.**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

La commande affiche un lien : ouvre-le sur n'importe quel appareil et connecte-toi
à ton compte Tailscale. Puis note le nom complet du serveur :

```bash
tailscale status
```

Le nom ressemble à `mon-pc.tail1a2b3c.ts.net`. Pour l'afficher en entier :

```bash
tailscale status --json | grep -m1 '"DNSName"'
```

(retire le point final : `mon-pc.tail1a2b3c.ts.net`). **Garde ce nom, il sert à
l'étape 4.**

Si le nom ne contient pas `.ts.net`, active **MagicDNS** dans la console :
https://login.tailscale.com/admin/dns.

### Sur ton téléphone et ton portable

Installe l'application **Tailscale**, connecte-toi au **même compte**, et
laisse-la activée. Sans elle, le serveur est invisible, ce qui est voulu.

---

## 3. Récupérer le code

```bash
cd ~
git clone https://github.com/guillaume-ctrlfallou/Movixsecure movix
cd movix
```

---

## 4. Générer la configuration

```bash
./deploy/setup.sh
```

Le script pose deux questions :

```
Hote [localhost] :        ← colle le nom Tailscale de l'étape 2 (mon-pc.tail1a2b3c.ts.net)
Cle API TMDB … :          ← colle ta clé TMDB
```

> ⚠️ **Mets bien le nom Tailscale, pas `localhost`.** Ce nom est écrit dans le
> site au moment de la compilation. Avec `localhost`, le site ne fonctionnerait
> que sur le serveur lui-même.

Le script crée le fichier `.env` avec tous les mots de passe générés
aléatoirement (droits 600) et une clé VIP propre à ton instance. **Tu n'as rien
d'autre à saisir.**

### Brancher Supabase (recommandé)

Cela copie tes comptes et ton historique hors du PC : si le PC tombe en panne ou
si tu le réinstalles, tu retrouves tout.

```bash
nano .env
```

Cherche (`Ctrl+W`) la ligne `SUPABASE_URL=` et remplis-la avec les deux lignes :

```
SUPABASE_URL=https://nsrevmfgxwioekykasgl.supabase.co
SUPABASE_SECRET_KEY=sb_secret_xxxxxxxxxxxxxxxxxxxxxxxx
```

Enregistre avec `Ctrl+O`, `Entrée`, puis quitte avec `Ctrl+X`.

> La clé doit commencer par **`sb_secret_`**. Si elle commence par
> `sb_publishable_`, c'est la mauvaise : le serveur le détecte et ignore Supabase
> avec un message clair.

---

## 5. Compiler et démarrer

```bash
docker compose build        # ~10 minutes la première fois, c'est normal
docker compose up -d
```

Attends **environ une minute** : MySQL doit finir de s'initialiser. Vérifie :

```bash
docker compose ps
```

Tous les services doivent être `running`, et `mysql` / `redis` `healthy`. Puis
les journaux :

```bash
docker compose logs mainapi | grep -E 'Bootstrap|supabase|sources'
```

Tu dois voir (les valeurs varient) :

```
[Bootstrap] Schema : 35 tables verifiees.
[Bootstrap] Cle VIP auto-hebergee active.
[supabase] active (nsrevmfgxwioekykasgl.supabase.co) — miroir actif
[supabase] miroir pret : 0 fichier(s) sur le disque, 0 dans Supabase, …
[sources] wiflix=flemmix.fast | coflix=coflix.date | …
```

Si une ligne `[supabase] … 401` ou `injoignable` apparaît, vérifie la clé et
l'URL dans `.env`, puis `docker compose up -d --force-recreate mainapi`.

---

## 6. Ouvrir Movix

Depuis **le serveur lui-même** d'abord, pour valider l'installation :
`http://localhost:3001`.

Puis depuis un **autre appareil avec Tailscale activé** :

```
http://mon-pc.tail1a2b3c.ts.net:3001
```

Crée ton compte avec la **phrase de 12 mots** (note-la, elle est ton seul accès).
Le VIP est déjà activé tout seul : rien à saisir.

### L'installer comme une application

- **Chrome / Edge (ordinateur)** : icône « Installer » dans la barre d'adresse.
- **Android** : menu ⋮ → *Ajouter à l'écran d'accueil*.
- **iPhone** : Partager → *Sur l'écran d'accueil*.

(En HTTP simple le mode hors-ligne est indisponible, la lecture n'est pas
affectée — voir `DEPLOIEMENT.md` § 4.)

---

## 7. Le vrai test : la connexion

C'est ce que tu voulais vérifier. Sur ton **téléphone, Wi-Fi coupé, en 4G** :

1. Ouvre le site (Tailscale activé).
2. Lance un film récent et note : **temps avant la première image**, et si ça
   **saccade** au bout de 2 à 3 minutes.
3. Essaie 3 ou 4 films différents. Note pour chacun : lecture directe (le lecteur
   de Movix) ou lecteur extérieur (avec pub).

Pour mesurer le débit du serveur vers l'extérieur :

```bash
sudo apt install -y speedtest-cli && speedtest-cli --simple
```

Regarde la ligne **Upload** : c'est elle qui limite la lecture à distance.
Repère :

| Upload | Ce que ça donne |
|---|---|
| > 15 Mb/s | 1080p confortable, plusieurs appareils |
| 5 à 15 Mb/s | 720p ou 1080p à un seul appareil |
| < 5 Mb/s | saccades probables hors de chez toi |

**Reviens me dire** l'upload, ce qui marche, et les films qui échouent (titre +
message). Je corrigerai à partir de là.

---

## 8. Au quotidien

```bash
cd ~/movix

docker compose ps                              # tout va bien ?
docker compose logs -f mainapi                 # suivre ce qui se passe
docker compose restart mainapi                 # après un changement de .env

# Sauvegarde automatique chaque nuit, 14 gardées
./deploy/backup.sh --install-cron

# Mise à jour du code
git pull && ./deploy/setup.sh && docker compose build && docker compose up -d --force-recreate
```

Les services redémarrent tout seuls après un redémarrage du PC
(`restart: unless-stopped`).

Quand une source déménage, ajoute son nouveau domaine dans `.env`
(`FSTREAM_BASE_URL=https://nouveau.tld`) ou dans la table `source_domains` de
Supabase, voir `DEPLOIEMENT.md` § 6 et 7 ter.

---

## 9. Sécurité : ce qui doit rester vrai

- ✅ **Aucun port ouvert sur la box.** Ne crée **aucune** redirection de port.
- ✅ Le site n'est joignable que via Tailscale. Ne partage pas l'adresse et ne la
  mets nulle part en ligne : la clé VIP est dans le site, quiconque y accède
  s'en sert comme relais.
- ✅ Le fichier `.env` contient tous tes secrets : ne le copie nulle part sans le
  chiffrer.
- ⚠️ Par défaut, les ports sont aussi ouverts sur ton **réseau local** (les
  appareils de ta box). Pour les limiter à Tailscale :

  ```bash
  sed -i "s/^BIND_ADDRESS=.*/BIND_ADDRESS=$(tailscale ip -4)/" .env
  docker compose up -d --force-recreate
  ```

  Réserve : au redémarrage du PC, si Docker démarre avant Tailscale, les
  conteneurs peuvent échouer à s'attacher. Dans ce cas
  `docker compose up -d` les relance.

---

## 10. En cas de problème

| Symptôme | Cause probable | Remède |
|---|---|---|
| `permission denied` sur docker | session non rechargée | se déconnecter / reconnecter |
| La page ne s'ouvre pas depuis le téléphone | Tailscale éteint sur le téléphone, ou mauvais nom | vérifier l'app Tailscale, puis `tailscale status` sur le serveur |
| La page s'ouvre mais le catalogue est vide | clé TMDB fausse | corriger dans `.env`, puis `docker compose build frontend && docker compose up -d frontend` |
| Erreur de connexion à l'API | `Hote` saisi = `localhost` | corriger `PUBLIC_*` dans `.env` avec le nom Tailscale, puis rebuild du frontend |
| `mainapi` redémarre en boucle | variable invalide | `docker compose logs mainapi \| tail -30` |
| Tous les films passent par un lecteur extérieur (pub) | extraction impossible | `DEPLOIEMENT.md` § 8, section « Tout passe par des iframes » |
| La vidéo saccade hors de chez toi | upload du serveur trop faible | résultat du test de l'étape 7 |
| Le serveur est lent / se fige | moins de 4 Go de RAM libre | `free -h`, fermer d'autres programmes |

Le dépannage détaillé est dans `DEPLOIEMENT.md` § 8.
