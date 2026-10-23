# Setlist backend

Fastify API for collaborative setlists. Yandex OAuth authenticates users; database membership controls songs and media. Owner/editor can edit and delete content; viewer can read. Owners manage roles and one-time invitations. New users never inherit legacy data. Setup and local verification: [docs/YANDEX_AUTH.md](docs/YANDEX_AUTH.md).

## Local start

1. Copy `.env.example` to `.env`. Replace both placeholder passwords with distinct random values and set `PWA_ORIGIN` to the exact browser origin.
2. Run `docker compose up -d --build`. The API container applies SQL migrations before listening. PostgreSQL and MinIO have persistent named volumes and no host ports.
3. Run `docker compose ps` and `curl -f http://localhost:3000/health`. All three services should be healthy and the endpoint should return `{"status":"ok"}`.

Use `docker compose down` to stop without deleting data. `docker compose down -v` removes the database and objects. For local TypeScript checks run `npm ci`, `npm run typecheck`, `npm run build`, and `npm run db:check`. `npm run db:migrate` applies migrations when `DATABASE_URL` points to a reachable PostgreSQL instance.

Image uploads are limited to 10 MiB and MP3 uploads to 50 MiB by default; configure `MAX_IMAGE_BYTES` and `MAX_MP3_BYTES` to change them. The object bucket is private and files are delivered through the API.

## Persistent local Yandex development

With `.env.yandex.runtime.local` configured, run `npm run local:up` and open **http://127.0.0.1:46544**. PostgreSQL, MinIO, API and PWA run in Docker with persistent external volumes and automatic restart. Stop: `npm run local:stop`. Back up: `npm run local:backup -- /absolute/path/to/new-backup`. See [local setup and recovery](docs/YANDEX_AUTH.md#persistent-local-yandex-stack).

## API contract

The contract is [openapi.yaml](openapi.yaml) and is also served at `/openapi.yaml`. Song creation uses `Idempotency-Key`; song edits and deletion use `If-Match` with the current song revision. File upload uses multipart `file`, `X-Attachment-Id` and `If-Match`. The API returns `code`, `message` and `requestId` on errors, plus `currentRevision` on a stale write. After any successful step, including a text save followed by a failed file upload, fetch `/v1/library/snapshot` to see the confirmed state. The client change `sync-client-with-backend` will implement this sequence and the offline copy; this repository contains no client code or offline write queue.

For manual media acceptance, put real files named `sample.png`, `sample.jpg`, `sample.webp` and `sample.mp3` in a temporary directory, then run `API_URL=http://127.0.0.1:3000 node scripts/acceptance-real-media.mjs /path/to/media`. The script checks upload, download, MIME, checksum, the image size limit, CORS and cleanup. It creates and removes a temporary song. The run in this change used files from [Samplelib PNG](https://samplelib.com/sample-png.html), [JPEG](https://samplelib.com/sample-jpeg.html), [WebP](https://samplelib.com/sample-webp.html) and [MP3](https://samplelib.com/sample-mp3.html).

## Backup and restore check

Current Mac/VPS runbook, verified production backup and migration notes: [docs/operations.md](docs/operations.md).

With the Compose stack running, execute `sh scripts/backup.sh /absolute/path/to/new-backup`. The script temporarily stops the API to keep the PostgreSQL dump and object list aligned. It writes `postgres.dump`, the object files, and `objects/manifest.json`. Store the directory off the server and protect it like the database: the backup contains private library data.

Run `sh scripts/verify-restore.sh /absolute/path/to/backup` to create an isolated Compose project with fresh volumes, restore the dump and objects, and verify every active attachment's size and SHA-256 against PostgreSQL metadata. The isolated project and volumes are removed afterward. A nonzero exit means the backup was not verified. The script does not change the primary Compose project.

## Production prototype

Production uses prebuilt GHCR frontend/backend images with PostgreSQL and MinIO on an internal Compose network. Only the frontend publishes HTTP port 80. Setup, GitHub Actions, backups, and rollback: [docs/PRODUCTION_DEPLOY.md](docs/PRODUCTION_DEPLOY.md). The Yandex replacement is being verified locally; production remains on the previous Telegram release until a separate authorized rollout. Configure HTTPS, Yandex client credentials and verify the intended owner before rollout.

Collaborative setlists use `/v1/setlists/:setlistId`, database roles and one-time invitations. Existing data is unowned until explicit local `npm run db:bootstrap-legacy` after verified owner login; this never runs at startup. See [Yandex auth and local adoption](docs/YANDEX_AUTH.md) and [OpenAPI](openapi.yaml). Songs belong to one setlist; copying creates independent songs and media objects.

## Formatting and commit checks

Use Node.js 22.22.1 or newer (CI and Docker use Node.js 24). Run `npm ci` to install dependencies and activate Husky Git hooks. Before each commit, lint-staged runs ESLint with automatic fixes and then Prettier on staged JavaScript/TypeScript files; supported staged documents and configuration files are formatted with Prettier. Files with remaining lint errors block the commit. Partially staged changes are handled by lint-staged.

Use `npm run lint` / `npm run lint:fix` for lint checks or fixes, and `npm run format:check` / `npm run format` for formatting checks or fixes. Generated Drizzle metadata, build output, dependencies and backups are excluded. Set `HUSKY=0` when installing in CI or Docker.

The application compiler stays on TypeScript 7 via the `typescript-compiler` npm alias; `build` and `typecheck` explicitly invoke that compiler. The `typescript` dependency provides TypeScript 6 for ESLint because typescript-eslint currently supports TypeScript versions below 6.1 and needs the JavaScript compiler API. No legacy peer dependency installation is required.
