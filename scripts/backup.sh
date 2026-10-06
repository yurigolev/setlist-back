#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then echo 'Usage: scripts/backup.sh <output-directory>' >&2; exit 2; fi
OUT=$(mkdir -p "$1" && cd "$1" && pwd)
if [ -e "$OUT/postgres.dump" ]; then echo 'Backup already exists' >&2; exit 1; fi
docker compose stop api
trap 'docker compose start api >/dev/null' EXIT
docker compose exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$OUT/postgres.dump"
docker compose run --rm -T -v "$OUT:/backup" api node dist/ops/objects.js backup /backup/objects
echo "Backup saved to $OUT"
