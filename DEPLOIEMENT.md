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
`MEDIA_SIGNING_SECRET`, `INTERNAL_API_KEY`, la clé VIP de l'instance — est tiré
de `/dev/urandom`.

Sans terminal (script, CI), passe les deux réponses en variables :

```bash
MOVIX_HOST=mon-pc.tail1234.ts.net TMDB_API_KEY=xxxx ./deploy/setup.sh
```

Aucun secret n'a de valeur par défaut dans le compose : s'il en manque un,
`docker compose up` refuse de démarrer au lieu de tourner avec une valeur
faible.

Au premier démarrage, `mainapi` crée les 35 tables du schéma et inscrit la clé
VIP de l'instance. Compte une minute avant que l'API réponde — MySQL doit finir
son initialisation. Dans les journaux :

```
[Bootstrap] Schema : 35 tables verifiees.
[Bootstrap] Cle VIP auto-hebergee active.
```

**Rien d'autre à faire.** Le VIP s'active tout seul dans le navigateur (§ 5 bis)
et le repli sur les lecteurs en iframe fonctionne (§ 5) : pas de requête SQL,
pas de réglage à saisir.

### Mettre à jour une installation existante

```bash
git pull
./deploy/setup.sh      # ajoute les nouvelles variables, ne modifie aucune existante
docker compose build
docker compose up -d --force-recreate
```

`setup.sh` détecte le `.env` existant et passe en **mise à niveau** : il n'ajoute
que les variables manquantes, sauvegarde l'ancien fichier, et ne touche à aucune
valeur présente. C'est important : MySQL fixe ses mots de passe à la création du
volume, et un `.env` aux secrets régénérés ne pourrait plus s'y connecter.

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

### Les lecteurs qui réclament de désactiver le sandbox

Plusieurs hébergeurs détectent l'attribut `sandbox` et refusent de servir la
vidéo. Ce n'est pas un défaut de l'app : ils sont rémunérés au popunder, et un
`window.open()` qui échoue leur signale qu'ils ne seront pas payés.

### Comment l'app choisit entre flux direct et iframe

```
1. Extraction côté serveur (VIP de l'instance, actif d'office)
   → réussie : flux lu en direct, la page de l'hébergeur n'est JAMAIS chargée,
               donc aucune de ses publicités
   → échouée  : repli ↓
2. Iframe de l'hébergeur, confinée par `sandbox`
   → le film est lu, avec la publicité de l'hébergeur
```

Les flux extraits sont ajoutés comme sources directes et placés en tête de
l'ordre de priorité (`WatchMovie.tsx`). Une iframe n'apparaît donc que
lorsque l'extraction n'a rien donné pour ce lien — c'est le repli. Deux
sources n'y passent jamais, par conception : **frembed** et **vostfr**
(lecteurs d'agrégateurs chargés tels quels).

### Pourquoi le repli ouvre les fenêtres

Le confinement le plus strict ferait échouer ce repli chez les hébergeurs qui
testent `window.open()` : on perdrait les films qu'ils sont seuls à proposer,
au lieu de les lire avec leur publicité. `VITE_EMBED_SANDBOX` règle ce point :

| Valeur | Fenêtres | Détournement d'onglet | Téléchargement forcé | Catalogue |
|---|---|---|---|---|
| **`balanced` (défaut)** | autorisées | bloqué | bloqué | complet |
| `strict` | bloquées | bloqué | bloqué | réduit |
| `off` | autorisées | **autorisé** | **autorisé** | complet |

`balanced` rend aux hébergeurs la seule chose qu'ils testent — la capacité
d'ouvrir une fenêtre — et rien d'autre. Surtout, `allow-popups-to-escape-sandbox`
reste absent : la fenêtre ouverte **hérite du même sandbox**, donc le popunder
est lui-même confiné et ne peut ni détourner l'onglet, ni déclencher de
téléchargement, ni rouvrir d'autres fenêtres.

On échange donc une nuisance publicitaire contre de la disponibilité — pas une
protection contre un risque d'infection. Les trois vecteurs dangereux restent
fermés.

`strict` reste disponible pour qui préfère perdre ces films plutôt que voir une
fenêtre publicitaire s'ouvrir. `off` n'a aucun intérêt : il satisfait les mêmes
hébergeurs que `balanced` en rouvrant le détournement d'onglet, précisément le
scénario « je regarde un film et mon onglet part sur une page vérolée ». Une
valeur mal orthographiée retombe sur `balanced`, jamais sur `off`.

Pour changer — la valeur est figée dans le bundle au build :

```bash
sed -i 's/^VITE_EMBED_SANDBOX=.*/VITE_EMBED_SANDBOX=strict/' .env
docker compose build frontend
docker compose up -d --force-recreate frontend
```

Un bloqueur de publicité dans le navigateur (uBlock Origin) se combine bien
avec `balanced` : l'hébergeur voit sa fenêtre s'ouvrir, le bloqueur en coupe
le contenu.

### Vérifier le confinement des lecteurs

Dans l'inspecteur, sur une page de lecture en iframe, l'attribut doit être :

```html
sandbox="allow-scripts allow-same-origin allow-forms allow-presentation allow-popups"
```

(sans `allow-popups` en mode `strict`)

Ce qui compte, ce sont les **absents** : ni `allow-top-navigation`, ni
`allow-popups-to-escape-sandbox`, ni `allow-downloads`, ni `allow-modals`. Ce
sont eux qui empêchent l'hébergeur de détourner ton onglet, de pousser un
fichier ou d'afficher une fausse alerte.

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

### Le VIP de l'instance — automatique

Le VIP n'est pas un contrôle de licence : c'est une ligne dans **ta** base, dans
la table `access_keys`. Sur une instance personnelle, il ne sert qu'à activer
l'extraction côté serveur (le mode de lecture sans page d'hébergeur, donc sans
leurs publicités) et la source IPTV.

**Il est actif d'office.** `setup.sh` génère `SELFHOST_VIP_KEY`, puis :

- le serveur l'inscrit dans `access_keys` à chaque démarrage, sans date
  d'expiration (`API/Mainapi/db/selfhostVip.js`) ;
- le frontend la reçoit au build et la pose dans le navigateur au premier
  chargement (`src/utils/selfhostVip.ts`).

Aucune requête SQL, aucune saisie dans les réglages, et aucun compte requis.

Détails utiles :

- **Portée.** La clé est figée dans le bundle, donc lisible par quiconque
  charge le site. Parfait derrière Tailscale. Si l'instance devient publique,
  vide `SELFHOST_VIP_KEY` dans `.env` puis rebuild : chaque visiteur serait
  sinon VIP, et pourrait se servir de ton serveur comme relais d'extraction.
- **Rotation.** Changer la valeur dans `.env` puis
  `docker compose build frontend && docker compose up -d --force-recreate`
  désactive l'ancienne clé au démarrage. Les clés créées à la main ne sont
  jamais touchées.
- **Retrait.** Si tu supprimes la clé depuis Réglages, elle n'est pas reposée
  au chargement suivant : c'est respecté comme un choix.
- **Clé déjà présente.** Un navigateur qui a déjà une clé (saisie à la main)
  la garde.

### Ajouter une clé à la main (optionnel)

Utile seulement pour une clé supplémentaire, par exemple sur une instance
publique où la clé automatique est coupée :

```bash
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -u root movix' <<'SQL'
INSERT INTO access_keys (key_value, active, duree_validite, expires_at)
VALUES ('ma-cle-perso', 1, '10 ans', (UNIX_TIMESTAMP() + 315360000) * 1000);
SQL
```

> **`expires_at` est en millisecondes**, pas en secondes. La colonne est un
> `BIGINT` et `checkVip.js` la lit avec `new Date(expires_at)`, qui interprète
> un nombre comme des millisecondes. La même convention est utilisée par le
> code qui délivre les clés (`utils/vipDonations.js` écrit `getTime()`).
> Une valeur en secondes donne une date de 1970 : la clé est acceptée par
> MySQL, puis refusée à l'usage avec « clé expirée ».
>
> Pour relire la date : `SELECT FROM_UNIXTIME(expires_at/1000) FROM access_keys;`

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

### D'où viennent les lecteurs

Un film affiché n'est pas forcément lisible. Derrière chaque lecteur, une
chaîne en trois étages, chacun pouvant casser seul :

```
1. Catalogue     TMDB                       → jamais de maintenance
2. Sites sources cherchent le film, renvoient des liens d'hébergeurs
3. Hébergeurs    stockent la vidéo ; l'extracteur en tire le flux direct
   → lecture directe si l'extraction réussit, sinon iframe (repli)
```

L'étage 2 casse le plus souvent : le site déménage et ses films perdent leurs
lecteurs. **Tous** les domaines se règlent donc dans le `.env`, sans toucher
au code :

| Variable | Source | Défaut |
|---|---|---|
| `WIFLIX_BASE_URL` | Wiflix (séries) | flemmix.fast |
| `COFLIX_BASE_URL` | Coflix | coflix.date |
| `CINESTREAM_BASE_URL` | Cinestream (films) | cinestream.info |
| `DARKIWORLD_BASE_URL` | Darkiworld | darkiworld2026.com |
| `FSTREAM_BASE_URL` | FStream | french-stream.one |
| `FRENCHSTREAM_BASE_URL` | FrenchStream | frenchstream.food |
| `VOIRDRAMA_BASE_URL` | VoirDrama | voirdrama.to |
| `ANIME_SAMA_BASE_URL` | Anime-Sama | anime-sama.to |
| `PURSTREAM_STATUS_URL` | PurStream — trouve son domaine **tout seul** | purstream.wiki/api/status |
| `PURSTREAM_API_BASE` | PurStream — repli si la page de statut tombe | api.purstream.id/api/v1 |
| `J1F_GO_URL` / `J1F_BASE_URL` | 1jour1film — **suit tout seul** le domaine | page `/go/` |
| `SWIFTFLOW_BASE_URL` | SwiftFlow | — |

Les valeurs par défaut et leur validation sont dans un seul fichier,
`API/Mainapi/config/sources.js`. Une valeur vide reprend le défaut ; une valeur
invalide aussi, avec un avertissement dans les journaux plutôt qu'un plantage.

Les domaines **effectivement utilisés** s'affichent au démarrage :

```bash
docker compose logs mainapi | grep '\[sources\]'
# [sources] wiflix=flemmix.fast | coflix=coflix.date | fstream=nouveau.tld (.env) | …
```

`(.env)` signale une valeur surchargée. Pour corriger une source qui a
déménagé :

```bash
echo 'FSTREAM_BASE_URL=https://nouveau-domaine.tld' >> .env
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

**Sauvegarde** — voir § 7 bis.

**Mise à jour** :

```bash
git pull
./deploy/setup.sh
docker compose build
docker compose up -d --force-recreate
```

`setup.sh` ne fait qu'ajouter les variables apparues depuis ta dernière
installation (voir § 3). Le `--force-recreate` garantit que chaque conteneur
repart avec sa nouvelle image et ses nouvelles variables.

**Réduire l'empreinte** — si tu ne regardes pas de chaînes commerciales
protégées, `API/proxiesembed/drmproxy/` (70 extracteurs DRM Widevine) ne te sert
à rien. Le supprimer allège l'image et retire la plus grosse surface de code du
projet. Voir aussi le § 8 de l'audit sur le point juridique, qui est d'une autre
nature que le reste.

---

## 7 bis. Sauvegarde et restauration

```bash
./deploy/backup.sh                  # sauvegarde maintenant
./deploy/backup.sh --install-cron   # automatique, chaque nuit à 03:30
```

Une archive datée `movix-AAAA-MM-JJ_HHMMSS.tar.gz` arrive dans
`~/movix-backups/` (réglable par `BACKUP_DIR`). Les 14 dernières sont gardées
(`BACKUP_KEEP`). Elle contient :

| Élément | Pourquoi |
|---|---|
| `.env` | **Critique.** MySQL fixe ses mots de passe à la création du volume : sans ce fichier, la base existante devient inaccessible |
| Base MySQL | comptes, profils, clés VIP, commentaires |
| Volume `mainapi-data` | historique, progression, favoris synchronisés |
| Supabase | uniquement si `SUPABASE_DB_URL` est renseignée — l'offre gratuite n'a **aucune** sauvegarde |
| `MANIFEST.txt` | date, commit, empreinte SHA-256 de chaque fichier |

Ne sont pas sauvegardés, volontairement : le cache (il se régénère), Redis
(cache et limites de débit), le code (sur GitHub).

Garde-fous :

- un export MySQL tronqué (disque plein, conteneur arrêté en cours de route)
  est **refusé** plutôt que conservé comme une sauvegarde inutilisable ;
- l'archive est écrite sous un nom temporaire puis renommée : jamais d'archive à
  moitié écrite ;
- la rotation n'a lieu **qu'après** un succès : un échec ne fait jamais
  disparaître une ancienne sauvegarde ;
- le volume de données est lu même si `mainapi` est en panne — c'est
  précisément là qu'on a besoin d'une sauvegarde ;
- dossier en 700, archives en 600 : elles contiennent tes secrets. Pour une copie
  hors de la machine, chiffre-la d'abord : `gpg -c movix-….tar.gz`.

Suivi de la sauvegarde automatique : `~/movix-backups/backup.log`.

### Restaurer

```bash
./deploy/restore.sh ~/movix-backups/movix-….tar.gz --check   # vérifie, ne touche à rien
./deploy/restore.sh ~/movix-backups/movix-….tar.gz           # remplace base + données
```

L'intégrité est vérifiée (gzip et SHA-256) avant toute écriture, et une
confirmation est demandée (`RESTAURER`).

Le `.env` n'est restauré **qu'avec `--with-env`**, et seulement sur une machine
neuve : sur une machine existante, l'écraser changerait les mots de passe
attendus par la base en place. Le `.env` remplacé est mis de côté
(`.env.avant-restauration.*`).

**Réinstallation complète sur une nouvelle machine :**

```bash
git clone <ton-dépôt> movix && cd movix
./deploy/restore.sh /chemin/movix-….tar.gz --with-env    # pose le .env d'origine
docker compose build && docker compose up -d mysql
./deploy/restore.sh /chemin/movix-….tar.gz               # base + données
docker compose up -d
```

---

## 8. Dépannage

| Symptôme | Cause probable |
|---|---|
| `mainapi` redémarre en boucle | MySQL pas encore prêt — attendre, puis lire `docker compose logs mysql` |
| Page blanche | CSP trop stricte : voir la console du navigateur, § 5 |
| Catalogue vide | `TMDB_API_KEY` absente ou invalide |
| Aucune source ne se résout | Un domaine source a bougé : § 6 |
| « Not allowed by CORS » ou « erreur de connexion » à l'activation d'une clé VIP | `ALLOWED_ORIGINS` ne contient pas l'hôte utilisé — le mettre **sans port** |
| Lecteur noir sur un hébergeur | Mode `strict` actif — voir § 5, ou changer de source |
| Un lecteur réclame de désactiver le sandbox | Mode `strict` actif, ou image frontend antérieure au défaut `balanced` — `docker compose build frontend` |
| Aucune source en lecture directe, tout passe par des iframes | L'extraction serveur échoue — voir ci-dessous |
| Pas de ligne `Cle VIP auto-hebergee active` au démarrage | `SELFHOST_VIP_KEY` absente : relancer `./deploy/setup.sh`, puis rebuild |
| Inaccessible à distance | Tailscale coupé, ou `.env` monté avec `localhost` : § 4 |
| `COPY failed: no source files were specified` | Ton Docker n'a pas lu les `deploy/Dockerfile.*.dockerignore` — voir ci-dessous |
| `mainapi` en `Restarting` + `TypeError: PROXIESEMBED_PUBLIC_URL invalide` | `PROXIESEMBED_PUBLIC_URL` absente ou en `http://` sur un hôte non-loopback — voir ci-dessous |

### Tout passe par des iframes

Le motif de chaque échec d'extraction est journalisé :

```bash
docker compose logs -f mainapi | grep -i extraction
```

```
[extraction] echec voe — HTTP 403 — https://voe.sx/e/abc
[extraction] echec vidmoly — ECONNREFUSED — https://vidmoly.to/embed-xyz
```

| Motif | Sens |
|---|---|
| `HTTP 404` / `HTTP 410` | Fichier supprimé chez l'hébergeur — normal, le repli prend le relais |
| `HTTP 403` sans code | L'hébergeur bloque l'IP du serveur |
| `VIP_REQUIRED` | `proxiesembed` refuse la clé — vérifier la ligne `Cle VIP auto-hebergee active` |
| `INTERNAL_KEY_REQUIRED` | `INTERNAL_API_KEY` différente entre les deux services |
| `ECONNREFUSED` / `ETIMEDOUT` | `proxiesembed` injoignable — voir ci-dessous |
| `unknown` + message | L'hébergeur a changé son obfuscation : l'extracteur est à mettre à jour |

Quand l'extraction serveur échoue, l'app retombe silencieusement sur les
embeds en iframe — et ce sont eux qui réclament la levée du sandbox. Aucune
erreur ne remonte : le `catch` d'`extractEmbed` est volontairement muet, un
hébergeur mort étant le cas normal.

La cause la plus probable est la confusion entre les trois URLs de
`proxiesembed`. `utils/embedExtraction.js` les essaie dans l'ordre
`PROXIESEMBED_INTERNAL_URL`, puis `PROXIESEMBED_PUBLIC_URL`, puis
`PROXY_SERVER_URL` amputé de `/proxy`. Renseigner la publique sans
l'interne fait donc prendre une URL destinée au navigateur pour un appel
serveur à serveur : avec une valeur en loopback, `mainapi` s'appelle
lui-même et aucune source ne se résout.

Vérifier que le conteneur voit bien l'URL interne :

```bash
docker compose exec mainapi sh -c 'printenv | grep PROXIESEMBED'
```

`PROXIESEMBED_INTERNAL_URL` doit valoir `http://proxiesembed:25569` — un nom
de service Docker, pas une adresse de loopback.

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

## 9. Ce qui a été vérifié, et comment

- **Build Docker et démarrage** : la stack complète a été construite et lancée
  sur un serveur Ubuntu réel, lecture vidéo comprise.
- **Schéma** : les 35 tables de `db/schema/` sont créées au démarrage
  (`db/bootstrapSchema.js`), vérifié sur un serveur MariaDB réel, idempotent.
- **Clé VIP de l'instance** : inscription, redémarrage sans doublon, rotation
  et clé manuelle préservée, vérifiés sur un serveur réel. L'acceptation de la
  clé est vérifiée par les **deux** codes qui la relisent — `checkVip.js` et
  `_check_vip` de `proxiesembed/server.py` — exécutés sur les lignes réelles.
- **Pose de la clé dans le navigateur** : les huit cas (navigateur vierge, clé
  existante, retrait volontaire, refus serveur, stockage inaccessible…) testés
  sur le module compilé, puis dans Chromium sur le bundle de production — où
  la toute première lecture de `is_vip` par l'application renvoie déjà
  `"true"` : la clé est en place avant que l'app ne s'exécute, donc dès le
  premier film.
- **`setup.sh`** : installation neuve, installation non interactive, refus sans
  clé TMDB, mise à niveau d'un `.env` ancien (valeurs existantes intactes,
  ligne à ligne) et relance sans effet.
- **Transmission par Docker Compose** : la même clé part au serveur et au build
  du frontend ; `balanced` s'applique même sans la variable.
- `npm run build` passe ; le préréglage de sandbox est vérifié pour chaque
  valeur, faute de frappe comprise.
- **Domaines des sources** : avec des domaines surchargés, les modules de
  routes réels contactent bien les nouveaux hôtes (requêtes interceptées), et
  `app.js` crée ses clients Coflix et FStream sur le domaine du `.env`.
- **Sauvegarde / restauration** : sur une base MariaDB réelle avec le schéma
  complet — sauvegarde, destruction de la base et des données, restauration,
  comparaison à l'identique. Testés aussi : archive altérée, export tronqué,
  MySQL arrêté, rotation, restauration sans confirmation, `--with-env` sur un
  `.env` existant, installation et retrait du cron sans toucher aux autres
  tâches.

Limite connue : les extracteurs d'hébergeurs dépendent de sites tiers qui
changent sans prévenir. Aucune instance — publique comprise — n'a 100 % de
sources en lecture directe ; c'est ce que le repli iframe couvre.
