# Production on one VPS

GitHub-hosted runners verify and build both applications. The VPS pulls tested
Linux amd64 images from GHCR; it never compiles the application. Every image tag
is the complete Git commit SHA.

Backend deployment files live in `/opt/setlist`:

- `docker-compose.prod.yml` and `Caddyfile`, owned by root. Caddy publishes ports
  80/443; frontend publishes only `127.0.0.1:8080` for local diagnostics.
- `.env.production`, owned by root, mode 600; generate separate database and MinIO
  passwords with `openssl rand -hex 32` and configure both initial image tags.
  Set `APP_DOMAIN=setlivo.ru` and `PWA_ORIGIN=https://setlivo.ru`.
- `/usr/local/sbin/setlist-deploy`, installed from `scripts/deploy.sh`, owned by
  root and executable. The deploy user may run only this script through sudo and
  cannot modify the Compose file or environment file.

Initial startup:

```sh
cd /opt/setlist
docker compose --env-file .env.production -f docker-compose.prod.yml pull
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --wait --wait-timeout 240
```

PostgreSQL and MinIO use persistent named volumes. Never run `down -v` on this
production stack. The `.env.production` file and volume backups must be preserved
outside the VPS as well.

In both GitHub repositories set Actions variables `DEPLOY_HOST`, `DEPLOY_USER`,
`DEPLOY_PORT`, and secrets `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`. Verify the VPS host
key before saving known_hosts. No passwords or private keys belong in Git.

The GHCR packages must be public for anonymous VPS pulls. Source repository
visibility does not automatically make its GHCR package public. Alternatively,
configure a server-side credential with only `read:packages`.

A push to `main` verifies, publishes, and deploys that component. Pull requests only
verify. Each repository serializes deployments; the VPS lock serializes updates
from both repositories and backups. Jobs skip their deployment when `main` has
advanced. The VPS rejects components and image tags outside the approved contract.

Manual image rollback:

```sh
sudo /usr/local/sbin/setlist-deploy frontend PREVIOUS_40_CHARACTER_COMMIT_SHA
sudo /usr/local/sbin/setlist-deploy backend PREVIOUS_40_CHARACTER_COMMIT_SHA
```

A failed healthcheck restores the previous image automatically. Backend startup
runs database migrations; image rollback does not reverse migrations. Release
migrations must remain compatible with the previous backend, or rollback needs a
verified database-and-object backup and a separate restoration procedure.

Production uses `https://setlivo.ru`. Point the domain A record at the VPS and open
TCP 80/443. Caddy obtains and renews the public certificate and redirects HTTP to
HTTPS. Preserve the `caddy_data` and `caddy_config` volumes. `/health` proxies the
actual API health; deploy checks this route through HTTPS with certificate
validation. HTTPS enables the PWA service worker; application access protection
is a separate feature.

Install `scripts/production-backup.sh` as root-owned `/usr/local/sbin/setlist-backup`
and copy `deploy/setlist-backup.{service,timer}` to `/etc/systemd/system`, then run
`systemctl daemon-reload && systemctl enable --now setlist-backup.timer`.
The timer runs daily around 04:30 UTC. Backups briefly stop API writes and include
PostgreSQL, attachment contents/manifests, Compose configuration, and production
environment and Caddyfile. Keep the backup directory private: it contains secrets. The newest
seven complete backup sets remain on the VPS. Copy them off-server separately.
Every backend deployment also takes a consistent backup before running migrations.

## Persistent authorization rollout

For the first Telegram/setlist rollout, follow [SAFE_RELEASE.md](SAFE_RELEASE.md): production Telegram credentials, a rehearsal from one complete backup, and explicit plan/apply adoption of the legacy library are required. Install the updated Compose and deploy script separately before releasing images; the existing image deployment does not copy those files. Healthchecks alone do not confirm owner access.

Migration `0007_refresh_sessions.sql` adds refresh families and hash history, with nullable family links for existing access sessions. Deploy the migrated backend before the matching client. Set `AUTH_SESSION_TTL_SECONDS=900` and `AUTH_REFRESH_TTL_SECONDS=7776000`; existing environment values override defaults. Access lasts 15 minutes, refresh renews for 90 days after successful rotation. Existing legacy cookie expiries remain unchanged and can bootstrap a family while valid. A rollback can retain the additive tables, but the previous backend cannot renew refresh sessions.
