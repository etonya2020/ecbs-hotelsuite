#!/bin/sh
# One-off backup. Works with PostgreSQL (DATABASE_URL=postgres://...) or the SQLite file.
#   DATABASE_URL=postgres://user:pass@host/db ./scripts/backup.sh [outfile]
set -e
OUT="${1:-ecbs-backup-$(date +%Y%m%d-%H%M%S)}"
case "$DATABASE_URL" in
  postgres*) pg_dump "$DATABASE_URL" | gzip > "$OUT.sql.gz"; echo "Saved $OUT.sql.gz" ;;
  *) F="${DATABASE_URL#sqlite:}"; F="${F:-./data/ecbs.db}"; sqlite3 "$F" ".backup '$OUT.db'" 2>/dev/null || cp "$F" "$OUT.db"; echo "Saved $OUT.db" ;;
esac
[ -n "$BACKUP_PASSPHRASE" ] && for f in "$OUT".sql.gz "$OUT".db; do [ -f "$f" ] && openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_PASSPHRASE -in "$f" -out "$f.enc" && rm "$f" && echo "Encrypted -> $f.enc"; done
exit 0
