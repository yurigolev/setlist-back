#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then echo 'Usage: scripts/verify-restore.sh <backup-directory>' >&2; exit 2; fi
BACKUP=$(cd "$1" && pwd)
test -s "$BACKUP/postgres.dump"
test -s "$BACKUP/objects/manifest.json"
COMPOSE_PROJECT_NAME="setlist-restore-$(date +%s)"
API_PORT=0
export COMPOSE_PROJECT_NAME API_PORT
trap 'docker compose down -v >/dev/null' EXIT
docker compose up -d --build
docker compose stop api
docker compose exec -T postgres sh -c 'pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$BACKUP/postgres.dump"
docker compose run --rm -T -v "$BACKUP:/backup:ro" api node dist/ops/objects.js restore /backup/objects
docker compose start api
docker compose exec -T api node dist/ops/verify-restore.js
