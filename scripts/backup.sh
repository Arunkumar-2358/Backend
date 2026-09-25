#!/usr/bin/env bash
# Nightly Postgres backup with 14-day rotation.  Cron: 30 1 * * * /app/scripts/backup.sh
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$DIR"
FILE="$DIR/recruit_crm_$(date +%Y%m%d_%H%M%S).dump"
pg_dump --format=custom --no-owner "${DATABASE_URL%%\?*}" > "$FILE"
echo "Backup written: $FILE ($(du -h "$FILE" | cut -f1))"
find "$DIR" -name 'recruit_crm_*.dump' -mtime +14 -delete
# Restore: pg_restore --clean --no-owner -d "$DATABASE_URL" <file>
