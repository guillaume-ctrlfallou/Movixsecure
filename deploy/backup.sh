#!/usr/bin/env bash
# Sauvegarde de l'instance Movix dans une archive datee.
#
# Contenu de l'archive :
#   env/.env              secrets de l'instance — SANS eux, la base MySQL
#                         existante devient inaccessible (mots de passe fixes
#                         a la creation du volume)
#   mysql/movix.sql       comptes, profils, cles VIP, commentaires…
#   data/data.tar         donnees synchronisees des utilisateurs (historique,
#                         progression, favoris : volume mainapi-data)
#   supabase/dump.sql     uniquement si SUPABASE_DB_URL est renseignee
#   MANIFEST.txt          date, commit, tailles, empreintes SHA-256
#
# Ce qui n'est PAS sauvegarde, volontairement : le cache (mainapi-cache, se
# regenere), Redis (cache et limites de debit), le code (sur GitHub).
#
# Usage :
#   ./deploy/backup.sh                  sauvegarde maintenant
#   ./deploy/backup.sh --install-cron   sauvegarde automatique chaque nuit a 03:30
#   ./deploy/backup.sh --remove-cron    retire la sauvegarde automatique
#
# Reglages (variables d'environnement ou .env) :
#   BACKUP_DIR   dossier de destination   (defaut : ~/movix-backups)
#   BACKUP_KEEP  nombre d'archives gardees (defaut : 14)
#
# L'archive contient des secrets : dossier en 700, archives en 600. Pour une
# copie hors de la machine (cle USB, cloud), chiffre-la d'abord, par exemple :
#   gpg -c movix-AAAA-MM-JJ_HHMMSS.tar.gz

set -euo pipefail
umask 077

cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"

env_value() { grep -E "^$1=" .env 2>/dev/null | head -n 1 | cut -d= -f2- || true; }

BACKUP_DIR="${BACKUP_DIR:-$(env_value BACKUP_DIR)}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/movix-backups}"
BACKUP_KEEP="${BACKUP_KEEP:-$(env_value BACKUP_KEEP)}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
CRON_TAG="# movix-backup"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die() { log "ERREUR : $*" >&2; exit 1; }

# --------------------------------------------------------------- cron -------
if [[ "${1:-}" == "--install-cron" ]]; then
    line="30 3 * * * cd '$REPO_DIR' && ./deploy/backup.sh >> '$BACKUP_DIR/backup.log' 2>&1 $CRON_TAG"
    mkdir -p "$BACKUP_DIR"
    # Lire la crontab AVANT d'ecrire : dans un seul pipeline `crontab -l | … |
    # crontab -`, l'ecriture peut commencer avant la fin de la lecture et
    # effacer les autres taches de l'utilisateur.
    current="$(crontab -l 2>/dev/null || true)"
    printf '%s\n%s\n' "$(printf '%s\n' "$current" | grep -v "$CRON_TAG" | sed '/^$/d')" "$line" | sed '/^$/d' | crontab -
    log "Sauvegarde automatique installee : chaque nuit a 03:30, journal dans $BACKUP_DIR/backup.log"
    exit 0
fi
if [[ "${1:-}" == "--remove-cron" ]]; then
    current="$(crontab -l 2>/dev/null || true)"
    printf '%s\n' "$current" | grep -v "$CRON_TAG" | sed '/^$/d' | crontab -
    log "Sauvegarde automatique retiree."
    exit 0
fi
[[ $# -eq 0 ]] || die "option inconnue : $1"

# ------------------------------------------------------------ verifs --------
[[ -f .env ]] || die ".env introuvable dans $REPO_DIR — rien a sauvegarder."
command -v docker >/dev/null || die "docker introuvable."
[[ "$BACKUP_KEEP" =~ ^[0-9]+$ && "$BACKUP_KEEP" -ge 1 ]] || die "BACKUP_KEEP doit etre un entier >= 1."

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP="$(date +%Y-%m-%d_%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/env" "$WORK/mysql" "$WORK/data"

log "Sauvegarde vers $BACKUP_DIR"

# 1. Secrets ------------------------------------------------------------------
cp .env "$WORK/env/.env"
log "✓ .env"

# 2. MySQL --------------------------------------------------------------------
# Le mot de passe est lu DANS le conteneur (variable MYSQL_ROOT_PASSWORD) : il
# n'apparait ni dans la ligne de commande de l'hote, ni dans un journal.
# --single-transaction : instantane coherent sans bloquer l'application.
docker compose exec -T mysql sh -c \
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -u root --single-transaction --routines --triggers --no-tablespaces --databases "$MYSQL_DATABASE"' \
    > "$WORK/mysql/movix.sql" \
    || die "export MySQL impossible. Le service mysql tourne-t-il ? (docker compose ps)"

# Un export tronque (disque plein, conteneur tue en cours de route) produit un
# fichier sans la ligne de fin de mysqldump : on le refuse plutot que de
# conserver une sauvegarde inutilisable.
grep -q "Dump completed" "$WORK/mysql/movix.sql" || die "export MySQL incomplet (pas de ligne « Dump completed »)."
grep -q "CREATE TABLE \`access_keys\`" "$WORK/mysql/movix.sql" || log "  ⚠ la table access_keys est absente de l'export — base jamais initialisee ?"
log "✓ MySQL ($(du -h "$WORK/mysql/movix.sql" | cut -f1))"

# 3. Donnees synchronisees (volume mainapi-data) --------------------------------
# `run --no-deps` plutot que `exec` : fonctionne meme si mainapi est arrete ou
# en echec, ce qui est precisement le moment ou on a besoin d'une sauvegarde.
docker compose run --rm --no-deps -T --entrypoint tar mainapi -C /app -cf - data \
    > "$WORK/data/data.tar" \
    || die "lecture du volume mainapi-data impossible."
tar -tf "$WORK/data/data.tar" >/dev/null || die "archive des donnees illisible."
log "✓ donnees utilisateurs ($(tar -tf "$WORK/data/data.tar" | grep -vc '/$') fichiers)"

# 4. Supabase (optionnel) -------------------------------------------------------
SUPABASE_DB_URL="${SUPABASE_DB_URL:-$(env_value SUPABASE_DB_URL)}"
if [[ -n "$SUPABASE_DB_URL" ]]; then
    mkdir -p "$WORK/supabase"
    # L'offre gratuite de Supabase n'inclut aucune sauvegarde : c'est celle-ci.
    docker run --rm -e PGURL="$SUPABASE_DB_URL" postgres:17-alpine \
        sh -c 'exec pg_dump --no-owner --no-privileges --schema=public "$PGURL"' \
        > "$WORK/supabase/dump.sql" \
        || die "export Supabase impossible (SUPABASE_DB_URL correcte ? projet en pause ?)."
    log "✓ Supabase ($(du -h "$WORK/supabase/dump.sql" | cut -f1))"
fi

# 5. Manifeste ------------------------------------------------------------------
{
    echo "Sauvegarde Movix — $STAMP"
    echo "Machine : $(hostname)"
    echo "Commit  : $(git rev-parse --short HEAD 2>/dev/null || echo inconnu)"
    echo
    echo "Fichiers (SHA-256) :"
    (cd "$WORK" && find . -type f ! -name MANIFEST.txt -print0 | sort -z | xargs -0 sha256sum)
} > "$WORK/MANIFEST.txt"

# 6. Archive --------------------------------------------------------------------
ARCHIVE="$BACKUP_DIR/movix-$STAMP.tar.gz"
tar -C "$WORK" -czf "$ARCHIVE.part" .
gzip -t "$ARCHIVE.part" || die "archive corrompue a l'ecriture."
mv "$ARCHIVE.part" "$ARCHIVE"   # renommage atomique : jamais d'archive a moitie ecrite
chmod 600 "$ARCHIVE"
log "✓ archive $(basename "$ARCHIVE") ($(du -h "$ARCHIVE" | cut -f1))"

# 7. Rotation -------------------------------------------------------------------
# Seulement apres le succes : un echec ne fait jamais disparaitre une ancienne
# sauvegarde.
mapfile -t OLD < <(ls -1t "$BACKUP_DIR"/movix-*.tar.gz 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))")
for f in "${OLD[@]}"; do rm -f -- "$f"; done
[[ ${#OLD[@]} -gt 0 ]] && log "Rotation : ${#OLD[@]} ancienne(s) archive(s) supprimee(s), $BACKUP_KEEP conservees."

log "Sauvegarde terminee."
