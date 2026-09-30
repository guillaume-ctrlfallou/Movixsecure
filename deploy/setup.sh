#!/usr/bin/env bash
# Genere le fichier .env de la stack Movix auto-hebergee.
#
# Tous les secrets sont tires de /dev/urandom : aucun n'est devinable, et
# aucun n'a de valeur par defaut dans le compose — un secret manquant fait
# echouer `docker compose up` au lieu de demarrer avec une valeur faible.
#
# Le script ne remplace jamais un .env existant sans le sauvegarder.

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env"

secret() { head -c "${1:-32}" /dev/urandom | base64 | tr -d '\n=+/' | head -c "${1:-32}"; }

if [[ -f "$ENV_FILE" ]]; then
    backup="${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
    cp "$ENV_FILE" "$backup"
    echo "→ .env existant sauvegarde dans $backup"
fi

# --- Adresse d'acces -------------------------------------------------------
# Les URLs figees dans le bundle frontend doivent etre celles que le
# NAVIGATEUR utilisera. Sur un tailnet, c'est le nom de machine Tailscale.
echo
echo "Sous quelle adresse accederas-tu a Movix depuis ton navigateur ?"
echo "  - nom Tailscale : mon-pc.tontailnet.ts.net   (acces de partout)"
echo "  - IP du LAN     : 192.168.1.42               (maison uniquement)"
echo "  - localhost     : localhost                  (cette machine uniquement)"
echo
read -rp "Hote [localhost] : " MOVIX_HOST
MOVIX_HOST="${MOVIX_HOST:-localhost}"

read -rp "Cle API TMDB (gratuite sur themoviedb.org/settings/api) : " TMDB_KEY
if [[ -z "$TMDB_KEY" ]]; then
    echo "ERREUR : sans cle TMDB il n'y a aucun catalogue. Abandon." >&2
    exit 1
fi

cat > "$ENV_FILE" <<EOF
# ===========================================================================
#  Movix — configuration auto-hebergee
#  Genere par deploy/setup.sh le $(date -Iseconds)
#
#  Ce fichier contient des secrets. Il est dans .gitignore : ne le commite
#  jamais, et ne le partage pas.
# ===========================================================================

# --- Acces -----------------------------------------------------------------
# Interface d'ecoute des ports publies.
#   0.0.0.0   : LAN + tailnet (defaut)
#   127.0.0.1 : cette machine uniquement
BIND_ADDRESS=0.0.0.0

# URLs vues par le navigateur. Figees dans le bundle au build : apres un
# changement ici, relancer \`docker compose build frontend\`.
PUBLIC_SITE_URL=http://${MOVIX_HOST}:3001
PUBLIC_MAIN_API=http://${MOVIX_HOST}:25565
PUBLIC_WATCHPARTY_API=http://${MOVIX_HOST}:25566
PUBLIC_PROXIES_EMBED_API=http://${MOVIX_HOST}:25569

# Origines admises par l'API. Remplace la liste codee en dur, qui contenait
# des domaines tiers (nakios.site, cinezo.site, filmib.cc...).
#
# HOSTNAMES SEULS, sans port : `isAllowedStaticOrigin` compare chaque entree
# au `hostname` de l'origine du navigateur, qui n'en porte jamais. Une entree
# `exemple.tld:3001` ne correspondait donc a rien et le CORS rejetait tout,
# avec pour seul symptome une « erreur de connexion » cote interface. Le
# serveur tolere desormais les deux ecritures, mais on genere la bonne.
ALLOWED_ORIGINS=${MOVIX_HOST%%:*},localhost

# --- Secrets (generes, ne pas reutiliser ailleurs) -------------------------
DB_ROOT_PASSWORD=$(secret 40)
DB_PASSWORD=$(secret 40)
DB_USER=movix
DB_NAME=movix
REDIS_PASSWORD=$(secret 40)
JWT_SECRET=$(secret 64)
# Doit etre identique entre mainapi et proxiesembed : c'est ce secret qui
# signe les URLs media. Les deux services le lisent depuis cette variable.
MEDIA_SIGNING_SECRET=$(secret 64)
INTERNAL_API_KEY=$(secret 48)
WATCHPARTY_ADMIN_SECRET=$(secret 40)

# --- Catalogue -------------------------------------------------------------
TMDB_API_KEY=${TMDB_KEY}

# Domaines des sources. Vides = valeurs par defaut du code. Quand une source
# demenage, c'est ICI qu'on corrige — jamais dans le code.
WIFLIX_BASE_URL=
COFLIX_BASE_URL=
CINESTREAM_BASE_URL=
DARKIWORLD_BASE_URL=
J1F_BASE_URL=
SWIFTFLOW_BASE_URL=

# --- Confinement des iframes d'hebergeurs ----------------------------------
# strict   : aucune fenetre, aucune navigation de l'onglet, aucun telechargement.
#            Le plus sur. Mais plusieurs hebergeurs detectent le sandbox et
#            refusent de servir la video : on perd le catalogue qu'ils sont
#            seuls a proposer.
# balanced : autorise les fenetres, et rien d'autre. Suffit a ces hebergeurs.
#            Leurs popunders s'ouvrent — mais herittent du meme sandbox, donc
#            ils ne peuvent ni detourner l'onglet, ni telecharger, ni rouvrir.
# off      : aucun confinement. Comportement d'origine du projet. Deconseille :
#            `balanced` satisfait les memes hebergeurs sans ce risque.
#
# Fige dans le bundle au build : apres un changement, relancer
#   docker compose build frontend && docker compose up -d --force-recreate frontend
VITE_EMBED_SANDBOX=strict

# --- KissKH (dramas asiatiques) --------------------------------------------
# URL de proxiesembed telle que le NAVIGATEUR la voit. Son validateur
# n'accepte `http://` que sur du loopback : toute autre machine doit etre en
# `https://`. En HTTP simple (cas d'un acces par Tailscale), laisser la valeur
# loopback ci-dessous — mainapi demarre, et seuls les sous-titres KissKH sont
# indisponibles. Avec un vrai HTTPS, mettre l'origine publique.
PROXIESEMBED_PUBLIC_URL=http://127.0.0.1:25569
KISSKH_ENABLED=false

# --- Live TV (optionnel) ---------------------------------------------------
# Vavoo marche sans rien : c'est la source TV utilisable telle quelle.
# Renseigner seulement si son domaine bouge.
VAVOO_BASE_URL=

# Northlive demande une cle partenaire qu'on n'a pas : laisser vide, la
# source restera simplement absente de la liste.
NORTHLIVE_API_KEY=

# Ton abonnement IPTV personnel, si tu en as un (source \"iptv\", VIP requis).
XTREAM_URL=
XTREAM_USER=
XTREAM_PASS=

# --- Reglages --------------------------------------------------------------
NUM_WORKERS=2
JWT_EXPIRES_IN=30d
DB_POOL_CONNECTION_LIMIT=10
VITE_APP_BUILD_ID=selfhosted-$(date +%Y%m%d)

# --- Anti-bot (optionnel) --------------------------------------------------
# Turnstile protege l'inscription et certaines sources. Sur une instance
# personnelle ou tu es le seul compte, on peut s'en passer.
VITE_TURNSTILE_SITE_KEY=
VITE_TURNSTILE_INVISIBLE_SITEKEY=
VITE_SUPPORT_TELEGRAM_URL=

# ===========================================================================
#  VOLONTAIREMENT ABSENTES — ne pas les rajouter
#
#  VITE_ANALYTICS_PROVIDER    -> absente = "none", aucune mesure
#  VITE_AD_DIRECT_URLS_ADULT  -> aucune pub +18
#  VITE_AD_DIRECT_URL_SFW     -> aucune pub SFW
#  VITE_AD_SCRIPT_SRC         -> aucun script de regie dans notre origine.
#                                C'est la variable la plus dangereuse du
#                                projet : le script injecte lit le
#                                localStorage, donc le jeton d'auth.
#  VITE_SWIFTFLUX_AD_URL      -> porte SwiftFlux sans etape pub
#  VITE_MIRRORS_CONFIG_URL    -> pas de redirection pilotee par rentry.co
#  VITE_DEFAULT_MIRRORS       -> pas de miroir de repli
#
#  Aucune n'etant definie, le popup publicitaire ne s'affiche plus du tout
#  (cf. hasAnyAdConfigured dans src/utils/adAdultMode.ts).
# ===========================================================================
EOF

chmod 600 "$ENV_FILE"

echo
echo "✓ .env genere (droits 600)"
echo
echo "Etapes suivantes :"
echo "  1. docker compose build      # ~10 min la premiere fois"
echo "  2. docker compose up -d"
echo "  3. docker compose logs -f mainapi"
echo
echo "Puis ouvre : http://${MOVIX_HOST}:3001"
echo
