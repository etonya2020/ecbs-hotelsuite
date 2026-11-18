#!/bin/sh
# Restore a PostgreSQL backup into an EMPTY database.   DATABASE_URL=postgres://... ./scripts/restore.sh backup.sql.gz[.enc]
set -e
F="$1"; [ -f "$F" ] || { echo "Usage: restore.sh <backup.sql.gz[.enc]>"; exit 1; }
case "$F" in
  *.enc) openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE -in "$F" | gunzip | psql "$DATABASE_URL" ;;
  *) gunzip -c "$F" | psql "$DATABASE_URL" ;;
esac
echo "Restore finished. Start the app; users keep their passwords."
