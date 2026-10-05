#!/usr/bin/env bash
# Restaure une archive produite par deploy/backup.sh.
#
# Usage :
#   ./deploy/restore.sh <archive.tar.gz>              restaure MySQL + donnees
#   ./deploy/restore.sh <archive.tar.gz> --with-env   restaure AUSSI le .env
#   ./deploy/restore.sh <archive.tar.gz> --check      verifie l'archive, ne touche a rien
#
# Le .env n'est pas restaure par defaut : sur une machine existante, l'ecraser
# changerait les mots de passe attendus par la base en place. Il ne doit etre
# restaure que sur une machine NEUVE, AVANT le premier `docker compose up` —
# c'est lui qui fixe alors les mots de passe des nouveaux volumes.
#
# Reinstallation complete sur une machine neuve :
#   git clone <ton-depot> movix && cd movix
#   ./deploy/restore.sh /chemin/movix-....tar.gz --with-env   # pose le .env
#   docker compose build && docker compose up -d mysql
#   ./deploy/restore.sh /chemin/movix-....tar.gz               # base + donnees
#   docker compose up -d

set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die() { log "ERREUR : $*" >&2; exit 1; }

ARCHIVE="${1:-}"
MODE="${2:-}"
[[ -n "$ARCHIVE" && -f "$ARCHIVE" ]] || die "usage : $0 <archive.tar.gz> [--with-env|--check]"
[[ -z "$MODE" || "$MODE" == "--with-env" || "$MODE" == "--check" ]] || die "option inconnue : $MODE"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1. Integrite -------------------------------------------------------------------
gzip -t "$ARCHIVE" || die "archive corrompue."
tar -C "$WORK" -xzf "$ARCHIVE"
[[ -f "$WORK/MANIFEST.txt" ]] || die "pas de MANIFEST.txt : ce n'est pas une archive de deploy/backup.sh."
(cd "$WORK" && grep -E '^[0-9a-f]{64}  ' MANIFEST.txt | sha256sum --quiet -c -) \
    || die "empreintes SHA-256 invalides : archive alteree."
log "✓ archive intacte — $(head -n 1 "$WORK/MANIFEST.txt")"

if [[ "$MODE" == "--check" ]]; then
    sed -n '2,3p' "$WORK/MANIFEST.txt"
    log "Contenu : $(cd "$WORK" && find . -type f ! -name MANIFEST.txt | sed 's#^\./##' | sort | tr '\n' ' ')"
    exit 0
fi

# 2. .env (machine neuve uniquement) ---------------------------------------------
if [[ "$MODE" == "--with-env" ]]; then
    if [[ -f .env ]]; then
        cp .env ".env.avant-restauration.$(date +%Y%m%d%H%M%S)"
        log "  .env actuel sauvegarde a cote (.env.avant-restauration.*)"
    fi
    cp "$WORK/env/.env" .env
    chmod 600 .env
    log "✓ .env restaure. Etape suivante : docker compose build && docker compose up -d mysql,"
    log "  puis relancer ce script SANS --with-env pour la base et les donnees."
    exit 0
fi

# 3. Confirmation -------------------------------------------------------------------
echo
echo "Cette restauration REMPLACE la base MySQL et les donnees utilisateurs actuelles."
echo "(Lance d'abord ./deploy/backup.sh si l'etat actuel a de la valeur.)"
if [[ -t 0 ]]; then
    read -rp "Taper RESTAURER pour continuer : " answer
    [[ "$answer" == "RESTAURER" ]] || die "abandon."
elif [[ "${MOVIX_RESTORE_CONFIRM:-}" != "RESTAURER" ]]; then
    die "sans terminal, definir MOVIX_RESTORE_CONFIRM=RESTAURER pour confirmer."
fi

# 4. MySQL ------------------------------------------------------------------------
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -u root' \
    < "$WORK/mysql/movix.sql" \
    || die "import MySQL impossible. mysql tourne-t-il ? (docker compose up -d mysql)"
log "✓ MySQL restaure"

# 5. Donnees synchronisees -------------------------------------------------------------
# Arrete mainapi pendant l'operation : il ecrit dans ce volume.
docker compose stop mainapi >/dev/null 2>&1 || true
docker compose run --rm --no-deps -T --entrypoint sh mainapi \
    -c 'rm -rf /app/data/* /app/data/.[!.]* 2>/dev/null; tar -C /app -xf -' \
    < "$WORK/data/data.tar" \
    || die "restauration du volume mainapi-data impossible."
log "✓ donnees utilisateurs restaurees"

if [[ -f "$WORK/supabase/dump.sql" ]]; then
    log "  Un export Supabase est present dans l'archive (supabase/dump.sql)."
    log "  Il n'est pas reimporte automatiquement : l'ecrasement d'une base distante"
    log "  partagee entre appareils doit rester une decision explicite."
fi

docker compose up -d mainapi >/dev/null
log "Restauration terminee. mainapi redemarre."
