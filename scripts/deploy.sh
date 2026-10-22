#!/usr/bin/env bash
# Install root-owned as /usr/local/sbin/setlist-deploy; allow sudo only this command.
set -Eeuo pipefail
if [[ $# != 2 || ! $2 =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Usage: setlist-deploy frontend|backend <40-character commit SHA>' >&2
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
compose=(docker compose --env-file "$env_file" -f /opt/setlist/docker-compose.prod.yml)
domain=$(sed -n 's/^APP_DOMAIN=//p' "$env_file")
[[ $domain =~ ^[a-zA-Z0-9.-]+$ ]] || { echo 'Missing or invalid APP_DOMAIN' >&2; exit 1; }
previous=$(sed -n "s/^${variable}=//p" "$env_file")
[[ $previous == "$repository":* ]] || { echo 'Missing previous image configuration' >&2; exit 1; }
image="$repository:$2"
docker pull "$image"
if [[ $service == api ]]; then
  # Validate the new image with the installed Compose/env before pausing writers.
  # Override CMD: this preflight imports configuration without running migrations.
  BACKEND_IMAGE="$image" "${compose[@]}" run --rm --no-deps -T -e NODE_USE_ENV_PROXY=0 api node --input-type=module -e '
    const { config } = await import("./dist/config.js");
    const auth = config.auth;
    const expected = `${config.pwaOrigin}/v1/auth/telegram/callback`;
    // Pre-auth images remain available for an explicit rollback of both clients.
    if (auth !== undefined && (!auth.enabled || !auth.secureCookies || !config.pwaOrigin.startsWith("https://") || auth.redirectUri !== expected)) {
      throw new Error("Production Telegram configuration is missing or callback does not match PWA_ORIGIN");
    }
    if (auth !== undefined) {
      // Parse a proxy URL without letting startup errors echo credentials.
      if (process.env.HTTPS_PROXY) {
        try {
          const proxy = new URL(process.env.HTTPS_PROXY);
          if (!["http:", "https:"].includes(proxy.protocol) || !proxy.hostname || proxy.hash || proxy.search) throw new Error();
        } catch {
          throw new Error("Production HTTPS proxy must be a valid HTTP(S) CONNECT proxy URL");
        }
        const { setGlobalProxyFromEnv } = await import("node:http");
        setGlobalProxyFromEnv();
      }
      // A browser may reach Telegram while the VPS cannot exchange codes.
      // Check the actual new image egress before stopping any running API.
      for (const path of ["/.well-known/openid-configuration", "/.well-known/jwks.json"]) {
        try {
          const response = await fetch(`https://oauth.telegram.org${path}`, {
            redirect: "error", signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) throw new Error("HTTP failure");
          const body = await response.json();
          if (path.endsWith("openid-configuration")
            ? body.issuer !== "https://oauth.telegram.org"
            : !Array.isArray(body.keys) || !body.keys.length) throw new Error("Invalid metadata");
        } catch {
          throw new Error("Production API cannot reach trusted Telegram metadata/JWKS; deployment aborted before backup or restart");
        }
      }
    }
  '
  /usr/local/sbin/setlist-backup --lock-held
fi
# Preserve settings so a failed replacement can restore the complete env file.
saved=$(mktemp /opt/setlist/.env.rollback.XXXXXX)
chmod 600 "$saved"
cp "$env_file" "$saved"
cleanup() { rm -f "$saved"; }
trap cleanup EXIT
sed -i "s|^${variable}=.*|${variable}=${image}|" "$env_file"
if "${compose[@]}" up -d --no-deps --no-build --pull never --wait --wait-timeout 180 "$service" && curl --fail --silent --show-error --connect-timeout 10 --max-time 20 --resolve "$domain:443:127.0.0.1" "https://$domain/health" >/dev/null; then
  printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$1" "$2" >> /opt/setlist/deployments.log
  echo "Deployed $1 $2"
else
  echo 'Deployment failed; restoring previous image. Database migrations are not reversed.' >&2
  cp "$saved" "$env_file"
  "${compose[@]}" up -d --no-deps --no-build --pull never --wait --wait-timeout 180 "$service"
  exit 1
fi
