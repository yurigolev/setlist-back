#!/usr/bin/env bash
# Install root-owned as /usr/local/sbin/setlist-deploy; allow sudo only this command.
set -Eeuo pipefail
if [[ $# -lt 2 || $# -gt 3 || ! $2 =~ ^[0-9a-f]{40}$ || ($# == 3 && $3 != --env-stdin) ]]; then
  echo 'Usage: setlist-deploy frontend|backend <40-character commit SHA> [--env-stdin]' >&2
  exit 2
fi
case "$1" in
  frontend) service=frontend; variable=FRONTEND_IMAGE; repository=ghcr.io/yurigolev/setlist-front-pwa ;;
  backend) service=api; variable=BACKEND_IMAGE; repository=ghcr.io/yurigolev/setlist-back ;;
  *) echo 'Unknown component' >&2; exit 2 ;;
esac
[[ $EUID == 0 ]] || { echo 'Run through sudo' >&2; exit 2; }
cd /opt/setlist
exec 9>/opt/setlist/deploy.lock
flock -w 600 9 || { echo 'Another deployment/backup is running' >&2; exit 1; }
env_file=/opt/setlist/.env.production
umask 077
saved=$(mktemp /opt/setlist/.env.rollback.XXXXXX)
candidate=$(mktemp /opt/setlist/.env.incoming.XXXXXX)
cp "$env_file" "$saved"
applied=false
succeeded=false
changed=false
compose=(docker compose --env-file "$candidate" -f /opt/setlist/docker-compose.prod.yml)
services=(--no-deps "$service")
cleanup() {
  status=$?
  trap - EXIT
  if $applied && ! $succeeded; then
    echo 'Deployment failed; restoring previous environment and images. Database migrations are not reversed.' >&2
    cp "$saved" "$env_file"
    docker compose --env-file "$env_file" -f /opt/setlist/docker-compose.prod.yml \
      up -d --no-build --pull never --wait --wait-timeout 180 "${services[@]}" || status=1
  fi
  rm -f "$saved" "$candidate"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cp "$env_file" "$candidate"
if [[ ${3:-} == --env-stdin ]]; then
  cat > "$candidate"
fi
# Treat incoming dotenv as data, never source/eval it. Keep release tags server-owned.
# Reject Compose control variables and accidental credential changes for existing data.
if ! changed=$(python3 - "$saved" "$candidate" "$variable" "$repository:$2" <<'PYENV'
import pathlib
import re
import sys

allowed = set("""APP_DOMAIN PWA_ORIGIN TRUSTED_PROXY_CHAIN POSTGRES_USER POSTGRES_PASSWORD
POSTGRES_DB MINIO_ROOT_USER MINIO_ROOT_PASSWORD MINIO_BUCKET MAX_IMAGE_BYTES MAX_MP3_BYTES
YANDEX_CLIENT_ID YANDEX_CLIENT_SECRET YANDEX_REDIRECT_URI TELEGRAM_CLIENT_ID
TELEGRAM_CLIENT_SECRET TELEGRAM_REDIRECT_URI AUTH_SESSION_TTL_SECONDS
AUTH_REFRESH_TTL_SECONDS AUTH_ALLOW_INSECURE_LOCAL_HTTP""".split())
images = {'FRONTEND_IMAGE', 'BACKEND_IMAGE'}
def read(path):
    result = {}
    for line in pathlib.Path(path).read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or key not in allowed | images or key in result:
            sys.exit('Invalid, duplicate or unsupported production environment key')
        result[key] = value
    return result
old = read(sys.argv[1])
new = read(sys.argv[2])
if not any(key in allowed and value.strip() for key, value in new.items()):
    sys.exit('Production environment is empty')
for key in ('POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'MINIO_BUCKET'):
    if new.get(key) != old.get(key):
        sys.exit(f'{key} requires a separate data/credential migration')
for key, repo in [('FRONTEND_IMAGE', 'setlist-front-pwa'), ('BACKEND_IMAGE', 'setlist-back')]:
    value = old.get(key, '')
    if not re.fullmatch(r'ghcr.io/yurigolev/' + repo + r':[0-9a-f]{40}', value):
        sys.exit('Missing or invalid installed image tag')
    new[key] = value
changed = {k: v for k, v in old.items() if k not in images} != {k: v for k, v in new.items() if k not in images}
new[sys.argv[3]] = sys.argv[4]
pathlib.Path(sys.argv[2]).write_text(''.join(f'{key}={value}\n' for key, value in new.items()))
print('true' if changed else 'false')
PYENV
); then
  exit 1
fi
if ! "${compose[@]}" config --quiet >/dev/null 2>&1; then
  echo 'Invalid production Compose environment; deployment aborted' >&2
  exit 1
fi
if $changed; then
  # Apply changed settings to every affected service, including API on frontend deploys.
  services=(postgres minio api frontend caddy)
fi
domain=$(sed -n 's/^APP_DOMAIN=//p' "$candidate")
[[ $domain =~ ^[a-zA-Z0-9.-]+$ ]] || { echo 'Missing or invalid APP_DOMAIN' >&2; exit 1; }
image="$repository:$2"
docker pull "$image"
if [[ $service == api ]] || $changed; then
  # Validate the new image with the installed Compose/env before pausing writers.
  # Override CMD: this preflight imports configuration without running migrations.
  "${compose[@]}" run --rm --no-deps -T api node --input-type=module -e '
    const { config } = await import("./dist/config.js");
    const auth = config.auth;
    const expected = `${config.pwaOrigin}/v1/auth/yandex/callback`;
    // Pre-auth images remain available for an explicit rollback of both clients.
    if (auth !== undefined && (!auth.enabled || !auth.secureCookies || !config.pwaOrigin.startsWith("https://") || auth.redirectUri !== expected)) {
      throw new Error("Production Yandex configuration is missing or callback does not match PWA_ORIGIN");
    }
    if (auth !== undefined) {
      // Public responses prove TLS and routing, not successful user consent.
      // Run from the new API image before backup or stopping the running API.
      for (const [url, expectedStatus] of [
        ["https://oauth.yandex.ru/authorize", 302],
        ["https://login.yandex.ru/info?format=json", 401],
      ]) {
        try {
          const response = await fetch(url, {
            redirect: "manual", signal: AbortSignal.timeout(5000),
          });
          if (response.status !== expectedStatus) throw new Error("Unexpected provider response");
          await response.body?.cancel();
        } catch {
          throw new Error("Production API cannot reach trusted Yandex OAuth/profile endpoints; deployment aborted before backup or restart");
        }
      }
    }
  '
  /usr/local/sbin/setlist-backup --lock-held
fi
# Backups and preflight used the previous live env and the candidate, respectively.
# Replace on the same filesystem; mode remains 600 and ownership remains root.
mv -f "$candidate" "$env_file"
applied=true
compose=(docker compose --env-file "$env_file" -f /opt/setlist/docker-compose.prod.yml)
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 180 "${services[@]}"
curl --fail --silent --show-error --connect-timeout 10 --max-time 20 \
  --resolve "$domain:443:127.0.0.1" "https://$domain/health" >/dev/null
printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$1" "$2" >> /opt/setlist/deployments.log
succeeded=true
echo "Deployed $1 $2"
