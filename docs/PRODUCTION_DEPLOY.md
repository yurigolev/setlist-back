# Production on one VPS

GitHub-hosted runners verify and build both applications. The VPS pulls tested
Linux amd64 images from GHCR; it never compiles the application. Every image tag
is the complete Git commit SHA.

Backend deployment files live in `/opt/setlist`:

- `docker-compose.prod.yml`, owned by root; frontend alone publishes HTTP port 80.
- `.env.production`, owned by root, mode 600; generate separate database and MinIO
  passwords with `openssl rand -hex 32` and configure both initial image tags.
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

At the current HTTP stage the browser can use the application, but service workers
and installed PWA offline mode require HTTPS on a public origin. `/health` proxies
the actual API health; it does not just report the nginx process. Domain, HTTPS,
and access protection are subsequent setup steps.

Install `scripts/production-backup.sh` as root-owned `/usr/local/sbin/setlist-backup`
and copy `deploy/setlist-backup.{service,timer}` to `/etc/systemd/system`, then run
`systemctl daemon-reload && systemctl enable --now setlist-backup.timer`.
The timer runs daily around 04:30 UTC. Backups briefly stop API writes and include
PostgreSQL, attachment contents/manifests, Compose configuration, and production
environment. Keep the backup directory private: it contains secrets. The newest
seven complete backup sets remain on the VPS. Copy them off-server separately.
Every backend deployment also takes a consistent backup before running migrations.
