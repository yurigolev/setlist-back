#!/usr/bin/env bash
# Install root-owned as /usr/local/sbin/setlist-backup.
set -Eeuo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root' >&2; exit 2; }
if [[ $# == 0 ]]; then
  exec 9>/opt/setlist/deploy.lock
  flock -w 600 9 || { echo 'Deployment/backup lock unavailable' >&2; exit 1; }
elif [[ $# != 1 || $1 != --lock-held ]]; then
  echo 'Usage: setlist-backup [--lock-held]' >&2
  exit 2
fi
cd /opt/setlist
compose=(docker compose --env-file /opt/setlist/.env.production -f /opt/setlist/docker-compose.prod.yml)
umask 077
mkdir -p /opt/setlist/backups
out=$(mktemp -d "/opt/setlist/backups/backup-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
# Stop writes before dumping DB and objects to keep both halves consistent.
"${compose[@]}" stop api
restart_api() { "${compose[@]}" start api >/dev/null; }
trap restart_api EXIT
"${compose[@]}" exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$out/postgres.dump"
"${compose[@]}" run --no-deps --rm -T -v "$out:/backup" api node dist/ops/objects.js backup /backup/objects
[[ -s $out/postgres.dump && -s $out/objects/manifest.json ]]
cp /opt/setlist/.env.production "$out/env.production"
cp /opt/setlist/docker-compose.prod.yml "$out/docker-compose.prod.yml"
touch "$out/COMPLETE"
# Retain the newest seven complete backup sets; incomplete backups stay for diagnosis.
mapfile -t old < <(find /opt/setlist/backups -mindepth 2 -maxdepth 2 -name COMPLETE -printf '%h\n' | sort -r | tail -n +8)
for directory in "${old[@]}"; do
  [[ $directory == /opt/setlist/backups/backup-* ]] && rm -rf -- "$directory"
done
echo "Backup saved: $out"
