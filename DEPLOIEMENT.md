# Déploiement personnel de Movix

Guide pour faire tourner Movix sur ta propre machine, y accéder depuis
n'importe où, sans publicité et sans exposer l'appareil.

À lire avec [`AUDIT-SECURITE.md`](./AUDIT-SECURITE.md), qui explique *pourquoi*
chaque durcissement est là.

---

## 1. Ce qui tourne

Six conteneurs, orchestrés par `docker-compose.yml` :

| Service | Port | Rôle |
|---|---|---|
| `frontend` | 3001 | L'app React, servie par un serveur Hono qui pose la CSP |
| `mainapi` | 25565 | API principale : catalogue, comptes, scrapers de sources |
| `proxiesembed` | 25569 | Relais des flux vidéo, signé en HMAC |
| `watchparty` | 25566 | Socket.IO des sessions synchronisées |
| `mysql` | — | Base de données, **non publiée** |
| `redis` | — | Cache et limitation de débit, **non publié** |

MySQL et Redis ne publient aucun port : ils ne sont joignables que par les
autres conteneurs. Une base exposée sur le réseau local est la première chose
que scanne un voisin de réseau.

---

## 2. Prérequis

- **Docker** avec Docker Compose v2 (`docker compose version`)
- **Une clé API TMDB**, gratuite : https://www.themoviedb.org/settings/api
  → sans elle il n'y a aucun catalogue, c'est la seule dépendance obligatoire
- ~4 Go de RAM libre, ~10 Go de disque
- Pas de nom de domaine, pas de certificat, pas d'ouverture de port sur la box

---

## 3. Installation

```bash
git clone <ton-dépôt> movix && cd movix
./deploy/setup.sh          # génère .env et tous les secrets
docker compose build       # ~10 min la première fois
docker compose up -d
docker compose logs -f mainapi
```

`setup.sh` demande deux choses : l'adresse sous laquelle tu accéderas au site,
et ta clé TMDB. Tout le reste — mots de passe MySQL et Redis, `JWT_SECRET`,
`MEDIA_SIGNING_SECRET`, `INTERNAL_API_KEY` — est tiré de `/dev/urandom`.

Aucun secret n'a de valeur par défaut dans le compose : s'il en manque un,
`docker compose up` refuse de démarrer au lieu de tourner avec une valeur
faible.

Au premier démarrage, `mainapi` crée ses tables (`CREATE TABLE IF NOT EXISTS`).
Compte une minute avant que l'API réponde — MySQL doit finir son initialisation.

---

## 4. Y accéder depuis n'importe où

C'est le point qui t'intéresse, et c'est là qu'on peut faire une erreur chère.

### ❌ Ce qu'il ne faut PAS faire

**N'ouvre pas de port sur ta box.** Rediriger le port 3001 vers ton PC te rend
scannable par Internet entier en quelques heures. Ton PC est sur le même réseau
que tes autres appareils : une compromission ne s'arrête pas au conteneur.
Et c'est toute la logique de l'audit qui tombe si la machine est exposée.

### ✅ Tailscale — la bonne réponse

Tailscale monte un réseau privé chiffré (WireGuard) entre tes appareils. Ton PC
devient joignable depuis ton téléphone, en 4G, à l'autre bout du monde —
**sans rien ouvrir sur ta box**, sans IP fixe, sans nom de domaine.

```bash
# Sur le PC qui héberge
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale status          # note le nom de la machine, ex. mon-pc
```

Installe ensuite l'app Tailscale sur ton téléphone et ton portable, connecte-les
au même compte, et c'est fini.

**Important** : les URLs du frontend sont figées dans le bundle au moment du
build. Il faut donc donner le nom Tailscale à `setup.sh` :

```
Hôte [localhost] : mon-pc.tontailnet.ts.net
```

Si tu as déjà installé avec `localhost`, corrige `.env` puis :

```bash
docker compose build frontend && docker compose up -d frontend
```

Tu accèdes alors à `http://mon-pc.tontailnet.ts.net:3001` depuis n'importe
lequel de tes appareils. Le trafic est chiffré de bout en bout par WireGuard,
même en HTTP.

### Une limite à connaître

En HTTP sur un nom autre que `localhost`, le navigateur refuse d'enregistrer le
**service worker** (il exige un « contexte sécurisé »). Conséquences : pas de
mode PWA, pas de cache hors-ligne. **La lecture vidéo fonctionne
normalement** — le service worker ne sert qu'au confort.

Si tu veux du vrai HTTPS, Tailscale délivre des certificats Let's Encrypt
valides pour les noms `.ts.net` :

```bash
sudo tailscale cert mon-pc.tontailnet.ts.net
tailscale serve --bg --https=443 3001
```

Il faut alors passer les `PUBLIC_*` du `.env` en `https://` et rebuilder le
frontend.

---

## 5. Ce qui est désactivé, et comment le vérifier

### Publicité : absente par construction

Les quatre variables de régie ne sont **pas** dans le `.env` généré. Le
frontend n'a donc aucune URL à ouvrir, et le popup « Voir une pub » ne
s'affiche plus du tout (`hasAnyAdConfigured` dans `src/utils/adAdultMode.ts`
dérive son état de la configuration).

La plus importante des quatre est `VITE_AD_SCRIPT_SRC` : elle injecte un script
de régie **dans l'origine de la page**, avec accès complet au `localStorage` —
donc au jeton d'authentification. Ne la remets pas.

### Télémétrie : absente

`VITE_ANALYTICS_PROVIDER` n'est pas défini → vaut `none` → aucun script tiers.

### Vérifier que la CSP est active

```bash
curl -sI http://localhost:3001/ | grep -i content-security-policy
```

Tu dois voir `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com
https://www.gstatic.com`. C'est cette directive qui empêche le chargement d'un
script de régie, même si quelqu'un remettait la variable.

Si un écran reste blanc, ouvre la console du navigateur : une CSP trop stricte
s'y signale explicitement. Pour diagnostiquer, décommente `CSP_DISABLED: "true"`
dans le service `frontend` du compose — **et remets-le après**.

### Vérifier le confinement des lecteurs

Dans l'inspecteur, sur une page de lecture, l'iframe de l'hébergeur doit porter :

```html
sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"
```

L'absence de `allow-top-navigation` et `allow-popups` est ce qui empêche
l'hébergeur de détourner ton onglet ou d'ouvrir des popunders.

### L'extension navigateur

**Ne l'installe pas.** Elle demande `<all_urls>`, tourne sur tous les sites que
tu visites, et n'y vérifie aucune origine : n'importe quelle page peut s'en
servir comme proxy HTTP pour scanner ton réseau local. Voir § 4.1 de l'audit.

L'extraction côté serveur suffit largement pour un usage personnel. Si le Live
TV te manque au point de vouloir l'extension, demande d'abord le correctif de
`content.js` — il tient en quelques lignes.

---

## 5 bis. Live TV — ce qui marche sans l'extension

Le Live TV agrège plusieurs sources de chaînes en direct. Toutes ne sont pas
accessibles de la même façon (`src/pages/LiveTV.tsx`) :

| Source | Accès | État sur une instance perso |
|---|---|---|
| **Vavoo** | Libre | ✅ **Marche tel quel** — HLS direct, aucune clé, aucun VIP |
| Northlive | Libre | ❌ Exige une clé partenaire absente du dépôt |
| IPTV (Xtream) | VIP | ⚙️ Marche avec **ton propre** abonnement IPTV |
| Matchs, autres | VIP **ou** extension | ⚙️ VIP suffit |

**Vavoo est donc la source à utiliser** : elle renvoie des `.m3u8` que le
lecteur consomme directement, sans proxy ni en-tête particulier.

Northlive apparaîtra vide tant que `NORTHLIVE_API_KEY` n'est pas renseignée.
Ce n'est pas une erreur de configuration : c'est une clé qu'on n'a pas.

### Se déclarer VIP sur sa propre instance

Le VIP n'est pas un contrôle de licence : c'est une ligne dans **ta** base, dans
la table `access_keys`. Sur ton instance, tu peux te l'accorder :

```bash
docker compose exec mysql mysql -u root -p"$DB_ROOT_PASSWORD" movix -e \
  "INSERT INTO access_keys (key_value, active, duree_validite, expires_at)
   VALUES ('ma-cle-perso', 1, '10 ans', UNIX_TIMESTAMP() + 315360000);"
```

Puis saisis `ma-cle-perso` dans l'app (Réglages → VIP). Le serveur la vérifie
dans `access_keys` via l'en-tête `x-access-key` — c'est `API/Mainapi/checkVip.js`
qui tranche, pas le navigateur.

Ça débloque la source IPTV et les catalogues réservés, **sans installer
l'extension**. La seule chose que le VIP ne remplace pas, ce sont les
catalogues que l'extension apporte elle-même (`GET_MANIFEST`) — et ceux-là ne
valent pas le risque décrit au § 4.1 de l'audit.

---

## 6. Maintenir le flux de nouveautés

**Il n'y a pas de catalogue à alimenter.** TMDB est l'index : un film sorti hier
apparaît dès que TMDB le référence. Aucune tâche planifiée chez toi.

Ce qui casse, c'est la **résolution des liens**, et presque toujours pour la
même raison : un site source a déménagé.

C'est pour ça que chaque source lit son domaine dans le `.env` :

```bash
WIFLIX_BASE_URL=https://nouveau-domaine.example
COFLIX_BASE_URL=
CINESTREAM_BASE_URL=
DARKIWORLD_BASE_URL=
J1F_BASE_URL=
SWIFTFLOW_BASE_URL=
```

Vide = la valeur par défaut du code. Après modification :

```bash
docker compose up -d mainapi     # pas de rebuild nécessaire
```

Le frontend n'est **pas** concerné : ces variables sont lues côté serveur à
chaud. Seules les `PUBLIC_*` imposent un rebuild.

Deux autres causes, plus rares :

- **Un hébergeur change de domaine** → `src/utils/hosterRegistry.ts`. Voe en
  tourne environ un par mois, d'où les 150+ alias déjà présents. L'app permet
  d'en ajouter sans rebuild : *Réglages → Priorité → Hosters custom & regex*.
- **Un hébergeur change son obfuscation** → il faut modifier les extracteurs.
  C'est le seul cas qui demande du développement.

---

## 7. Exploitation

```bash
docker compose ps                      # état et santé des services
docker compose logs -f mainapi         # journaux
docker compose restart mainapi         # redémarrage d'un service
docker compose down                    # arrêt (les volumes survivent)
docker compose down -v                 # ⚠️ arrêt + SUPPRESSION des données
```

**Sauvegarde** — comptes, profils, historique :

```bash
docker compose exec mysql mysqldump -u root -p"$DB_ROOT_PASSWORD" movix \
  > sauvegarde-$(date +%F).sql
```

**Mise à jour** :

```bash
git pull && docker compose build && docker compose up -d
```

**Réduire l'empreinte** — si tu ne regardes pas de chaînes commerciales
protégées, `API/proxiesembed/drmproxy/` (70 extracteurs DRM Widevine) ne te sert
à rien. Le supprimer allège l'image et retire la plus grosse surface de code du
projet. Voir aussi le § 8 de l'audit sur le point juridique, qui est d'une autre
nature que le reste.

---

## 8. Dépannage

| Symptôme | Cause probable |
|---|---|
| `mainapi` redémarre en boucle | MySQL pas encore prêt — attendre, puis lire `docker compose logs mysql` |
| Page blanche | CSP trop stricte : voir la console du navigateur, § 5 |
| Catalogue vide | `TMDB_API_KEY` absente ou invalide |
| Aucune source ne se résout | Un domaine source a bougé : § 6 |
| « Not allowed by CORS » | `ALLOWED_ORIGINS` ne contient pas l'hôte utilisé |
| Lecteur noir sur un hébergeur | Le sandbox le gêne — changer de source plutôt que de retirer le sandbox |
| Inaccessible à distance | Tailscale coupé, ou `.env` monté avec `localhost` : § 4 |
| `COPY failed: no source files were specified` | Ton Docker n'a pas lu les `deploy/Dockerfile.*.dockerignore` — voir ci-dessous |
| `mainapi` en `Restarting` + `TypeError: PROXIESEMBED_PUBLIC_URL invalide` | `PROXIESEMBED_PUBLIC_URL` absente ou en `http://` sur un hôte non-loopback — voir ci-dessous |

### `TypeError: PROXIESEMBED_PUBLIC_URL invalide`

`routes/kisskh.js` valide cette URL **au chargement du module**, hors de tout
`try/catch` : une valeur refusée empêche `mainapi` de démarrer et le cluster
boucle sur le redémarrage. Le reste de la stack reste `healthy`, ce qui rend le
symptôme trompeur — le catalogue continue de s'afficher, puisque le frontend
interroge TMDB directement, mais plus aucune source ne se résout.

Son validateur n'accepte `http://` que sur `localhost`, `127.0.0.1` ou `[::1]`.
Tout autre hôte doit être en `https://`. Et le contrôle a lieu **avant** le test
`KISSKH_ENABLED` : désactiver KissKH ne suffit donc pas à éviter le plantage.

Le `.env` généré met `http://127.0.0.1:25569`, qui satisfait le validateur. La
conséquence est limitée à KissKH : l'URL remise au client pointerait vers sa
propre machine, donc ses sous-titres ne chargent pas. Aucune autre source
n'utilise cette valeur.

Sur un déploiement en HTTPS, remplace-la par l'origine publique
(`https://exemple.tld:25569`) et remets `KISSKH_ENABLED=true`.

### Si le build échoue sur « COPY failed »

Le `.dockerignore` de la racine exclut `API/` : il est écrit pour le build du
**frontend**, qui n'a pas besoin des backends. Les images backend le
contournent avec un fichier d'exclusion dédié (`deploy/Dockerfile.mainapi.dockerignore`
et ses deux voisins), que BuildKit lit en priorité.

Si ta version de Docker ne gère pas cette convention, le build s'arrête net sur
`COPY failed`. Contournement : commente la ligne `API` dans le `.dockerignore`
de la racine, rebuild, puis remets-la.

```bash
sed -i 's/^API$/# API/' .dockerignore
docker compose build
sed -i 's/^# API$/API/' .dockerignore
```

---

## 9. Ce qui n'a pas été vérifié

Honnêteté sur les limites de ce guide :

- **Le build Docker n'a pas pu être testé** : l'environnement où ces fichiers
  ont été écrits n'a pas de démon Docker. Le YAML est valide et les Dockerfiles
  suivent les contraintes réelles des dépendances (glibc pour les modules
  natifs de `mainapi`, roues manylinux pour `proxiesembed`), mais le premier
  `docker compose build` peut demander un ajustement. Signale l'erreur, elle se
  corrigera vite.
- **Le schéma MySQL s'auto-amorce** via les `CREATE TABLE IF NOT EXISTS` de
  `app.js`, mais tout le schéma de `db/schema/` n'est pas couvert au boot.
  Si une route échoue sur une table manquante, sa définition est là.
- `npm run build` du frontend, lui, **a été exécuté et passe**.
