#!/usr/bin/env bash
# Prepare le fichier .env de la stack Movix auto-hebergee.
#
# Deux modes, choisis automatiquement :
#
#   INSTALLATION  — pas de .env : il est cree, tous les secrets tires de
#                   /dev/urandom.
#   MISE A NIVEAU — un .env existe : seules les variables MANQUANTES sont
#                   ajoutees. Aucune valeur existante n'est modifiee.
#
# Le second mode corrige un defaut de la version precedente, qui regenerait
# tous les secrets a chaque execution. Or MySQL fixe ses mots de passe a la
# creation du volume : un .env regenere ne correspond plus a la base, et
# mainapi ne peut plus s'y connecter. Relancer ce script apres un `git pull`
# est desormais la facon normale de recuperer les nouvelles variables.
#
# Non interactif : definir MOVIX_HOST et TMDB_API_KEY dans l'environnement
# evite toute question. Exemple :
#   MOVIX_HOST=mon-pc.tail1234.ts.net TMDB_API_KEY=xxxx ./deploy/setup.sh
#
# Aucun secret n'a de valeur par defaut dans le compose : un secret manquant
# fait echouer `docker compose up` au lieu de demarrer avec une valeur faible.

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env"

secret() { head -c "${1:-32}" /dev/urandom | base64 | tr -d '\n=+/' | head -c "${1:-32}"; }

# Valeur d'une cle dans le .env existant (vide si absente).
env_value() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -n 1 | cut -d= -f2- || true; }

# Pose une question seulement si un terminal est disponible.
ask() {
    local prompt="$1" default="${2:-}" answer=""
    if [[ -t 0 ]]; then
        read -rp "$prompt" answer
    fi
    printf '%s' "${answer:-$default}"
}

render_template() {
cat <<EOF
# ===========================================================================
#  Movix — configuration auto-hebergee
#  Genere par deploy/setup.sh le $(date -Iseconds)
#
#  Ce fichier contient des secrets. Il est dans .gitignore : ne le commite
#  jamais, et ne le partage pas.
#
#  Apres un \`git pull\`, relancer ./deploy/setup.sh : il ajoute les nouvelles
#  variables sans modifier celles-ci.
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
# HOSTNAMES SEULS, sans port : \`isAllowedStaticOrigin\` compare chaque entree
# au \`hostname\` de l'origine du navigateur, qui n'en porte jamais. Le serveur
# tolere les deux ecritures, mais on genere la bonne.
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

# --- Cle VIP de l'instance -------------------------------------------------
# Active l'extraction cote serveur : les flux sont lus en direct, la page de
# l'hebergeur n'est jamais chargee, donc ses publicites non plus. Le serveur
# l'inscrit en base a chaque demarrage et le navigateur la pose tout seul :
# aucune requete SQL, aucune saisie dans les reglages.
#
# Elle est figee dans le bundle du frontend, donc lisible par quiconque
# charge le site. Parfait derriere Tailscale. Si l'instance devient publique,
# VIDER cette ligne : chaque visiteur serait VIP.
#
# La changer desactive l'ancienne au demarrage suivant. Apres modification :
#   docker compose build frontend && docker compose up -d --force-recreate
SELFHOST_VIP_KEY=$(secret 40)

# --- Catalogue -------------------------------------------------------------
TMDB_API_KEY=${TMDB_KEY}

# Domaines des sources. Vides = valeurs par defaut (API/Mainapi/config/sources.js).
# Quand une source demenage, c'est ICI qu'on corrige — jamais dans le code —
# puis \`docker compose up -d mainapi\` (pas de rebuild). Les domaines effectifs
# s'affichent au demarrage : docker compose logs mainapi | grep '\[sources\]'
WIFLIX_BASE_URL=
COFLIX_BASE_URL=
CINESTREAM_BASE_URL=
DARKIWORLD_BASE_URL=
J1F_BASE_URL=
SWIFTFLOW_BASE_URL=
FSTREAM_BASE_URL=
FRENCHSTREAM_BASE_URL=
VOIRDRAMA_BASE_URL=
ANIME_SAMA_BASE_URL=
# PurStream trouve son domaine d'API tout seul via cette page de statut.
PURSTREAM_STATUS_URL=
PURSTREAM_API_BASE=

# --- Supabase (optionnel) --------------------------------------------------
# Copie des comptes, profils et historiques dans Supabase (restauree toute
# seule sur un serveur reinstalle), et domaines des sources modifiables depuis
# le tableau de bord Supabase (table source_domains) : le .env ci-dessus garde
# la priorite. Vides = tout reste local, comme avant.
#
# URL : Project Settings > Data API. Cle : Project Settings > API Keys >
# « Secret keys » (sb_secret_…) — JAMAIS la cle publishable.
# SUPABASE_MIRROR=off coupe le miroir et garde les domaines.
SUPABASE_URL=${SUPABASE_URL:-}
SUPABASE_SECRET_KEY=
SUPABASE_MIRROR=

# --- Confinement des iframes d'hebergeurs ----------------------------------
# Une iframe n'est affichee que lorsque l'extraction n'a pas produit de flux
# direct : c'est le repli. Plusieurs hebergeurs detectent le sandbox et
# refusent de servir la video si leurs fenetres publicitaires sont bloquees.
#
# balanced : (defaut) autorise les fenetres, et rien d'autre. Le repli
#            fonctionne, avec la publicite de l'hebergeur. Les fenetres
#            heritent du sandbox : ni detournement d'onglet, ni
#            telechargement force, ni fausses alertes.
# strict   : aucune fenetre. On perd les films que seuls ces hebergeurs
#            proposent.
# off      : aucun confinement. Deconseille : satisfait les memes hebergeurs
#            que balanced en rouvrant le detournement d'onglet.
#
# Fige dans le bundle au build : apres un changement, relancer
#   docker compose build frontend && docker compose up -d --force-recreate frontend
VITE_EMBED_SANDBOX=balanced

# --- KissKH (dramas asiatiques) --------------------------------------------
# URL de proxiesembed telle que le NAVIGATEUR la voit. Son validateur
# n'accepte \`http://\` que sur du loopback : toute autre machine doit etre en
# \`https://\`. En HTTP simple (cas d'un acces par Tailscale), laisser la valeur
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

# Ton abonnement IPTV personnel, si tu en as un (source "iptv", VIP requis).
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
#  Aucune n'etant definie, le popup publicitaire de Movix ne s'affiche plus
#  (cf. hasAnyAdConfigured dans src/utils/adAdultMode.ts).
# ===========================================================================
EOF
}

if [[ ! -f "$ENV_FILE" ]]; then
    # ------------------------------------------------------------------ neuf
    echo "Installation : creation de $ENV_FILE"
    if [[ -z "${MOVIX_HOST:-}" ]]; then
        echo
        echo "Sous quelle adresse accederas-tu a Movix depuis ton navigateur ?"
        echo "  - nom Tailscale : mon-pc.tontailnet.ts.net   (acces de partout)"
        echo "  - IP du LAN     : 192.168.1.42               (maison uniquement)"
        echo "  - localhost     : localhost                  (cette machine uniquement)"
        echo
        MOVIX_HOST="$(ask 'Hote [localhost] : ' localhost)"
    fi
    TMDB_KEY="${TMDB_API_KEY:-}"
    if [[ -z "$TMDB_KEY" ]]; then
        TMDB_KEY="$(ask 'Cle API TMDB (gratuite sur themoviedb.org/settings/api) : ')"
    fi
    if [[ -z "$TMDB_KEY" ]]; then
        echo "ERREUR : sans cle TMDB il n'y a aucun catalogue." >&2
        echo "         Relancer avec TMDB_API_KEY=... ./deploy/setup.sh" >&2
        exit 1
    fi

    render_template > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "✓ $ENV_FILE cree (droits 600)"
else
    # ------------------------------------------------------------ mise a niveau
    echo "Mise a niveau : $ENV_FILE existe, seules les variables manquantes seront ajoutees."
    echo "                Aucune valeur existante n'est modifiee."

    # Les valeurs dependant de l'hote ou de TMDB ne servent que si elles
    # manquent : on les reconstitue depuis le .env actuel.
    if [[ -z "${MOVIX_HOST:-}" ]]; then
        MOVIX_HOST="$(env_value PUBLIC_SITE_URL | sed -E 's#^https?://##; s#[:/].*$##')"
        MOVIX_HOST="${MOVIX_HOST:-localhost}"
    fi
    TMDB_KEY="$(env_value TMDB_API_KEY)"
    TMDB_KEY="${TMDB_KEY:-${TMDB_API_KEY:-}}"

    tmp="$(mktemp)"
    trap 'rm -f "$tmp"' EXIT
    render_template > "$tmp"

    added=()
    while IFS= read -r line; do
        [[ "$line" =~ ^([A-Z0-9_]+)= ]] || continue
        key="${BASH_REMATCH[1]}"
        grep -qE "^${key}=" "$ENV_FILE" && continue
        if [[ ${#added[@]} -eq 0 ]]; then
            cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
            printf '\n# --- Ajoute par deploy/setup.sh le %s ---\n' "$(date -Iseconds)" >> "$ENV_FILE"
        fi
        printf '%s\n' "$line" >> "$ENV_FILE"
        added+=("$key")
    done < "$tmp"

    chmod 600 "$ENV_FILE"
    if [[ ${#added[@]} -eq 0 ]]; then
        echo "✓ Rien a ajouter : $ENV_FILE est complet."
    else
        echo "✓ ${#added[@]} variable(s) ajoutee(s) : ${added[*]}"
        echo "  (sauvegarde de l'ancien fichier : ${ENV_FILE}.bak.*)"
    fi
    if [[ -z "$(env_value TMDB_API_KEY)" ]]; then
        echo "⚠ TMDB_API_KEY est vide : renseigne-la dans $ENV_FILE, sinon aucun catalogue." >&2
    fi
fi

echo
echo "Etapes suivantes :"
echo "  docker compose build        # ~10 min la premiere fois"
echo "  docker compose up -d"
echo "  docker compose logs -f mainapi"
echo
echo "Puis ouvre : $(env_value PUBLIC_SITE_URL)"
if ! crontab -l 2>/dev/null | grep -q "# movix-backup"; then
    echo "Sauvegarde automatique non installee. Pour l'activer (chaque nuit, 14 gardees) :"
    echo "  ./deploy/backup.sh --install-cron"
fi
if [[ -n "$(env_value SELFHOST_VIP_KEY)" ]]; then
    echo "Le VIP est active automatiquement dans le navigateur, rien a saisir."
fi
