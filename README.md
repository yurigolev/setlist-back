# Setlist backend

Fastify API for one personal music library. **The API is public:** anyone who knows its address can read and change the library. CORS limits browser origins only; it does not authenticate direct HTTP clients. Do not store private data until authentication is added separately.

## Local start

1. Copy `.env.example` to `.env`. Replace both placeholder passwords with distinct random values and set `PWA_ORIGIN` to the exact browser origin.
2. Run `docker compose up -d --build`. The API container applies SQL migrations before listening. PostgreSQL and MinIO have persistent named volumes and no host ports.
3. Run `docker compose ps` and `curl -f http://localhost:3000/health`. All three services should be healthy and the endpoint should return `{"status":"ok"}`.

Use `docker compose down` to stop without deleting data. `docker compose down -v` removes the database and objects. For local TypeScript checks run `npm ci`, `npm run typecheck`, `npm run build`, and `npm run db:check`. `npm run db:migrate` applies migrations when `DATABASE_URL` points to a reachable PostgreSQL instance.

Image uploads are limited to 10 MiB and MP3 uploads to 50 MiB by default; configure `MAX_IMAGE_BYTES` and `MAX_MP3_BYTES` to change them. The object bucket is private and files are delivered through the API.

## API contract

The contract is [openapi.yaml](openapi.yaml) and is also served at `/openapi.yaml`. Song creation uses `Idempotency-Key`; song edits and deletion use `If-Match` with the current song revision. File upload uses multipart `file`, `X-Attachment-Id` and `If-Match`. The API returns `code`, `message` and `requestId` on errors, plus `currentRevision` on a stale write. After any successful step, including a text save followed by a failed file upload, fetch `/v1/library/snapshot` to see the confirmed state. The client change `sync-client-with-backend` will implement this sequence and the offline copy; this repository contains no client code or offline write queue.

For manual media acceptance, put real files named `sample.png`, `sample.jpg`, `sample.webp` and `sample.mp3` in a temporary directory, then run `API_URL=http://127.0.0.1:3000 node scripts/acceptance-real-media.mjs /path/to/media`. The script checks upload, download, MIME, checksum, the image size limit, CORS and cleanup. It creates and removes a temporary song. The run in this change used files from [Samplelib PNG](https://samplelib.com/sample-png.html), [JPEG](https://samplelib.com/sample-jpeg.html), [WebP](https://samplelib.com/sample-webp.html) and [MP3](https://samplelib.com/sample-mp3.html).

## Backup and restore check

Current Mac/VPS runbook, verified production backup and migration notes: [docs/operations.md](docs/operations.md).

With the Compose stack running, execute `sh scripts/backup.sh /absolute/path/to/new-backup`. The script temporarily stops the API to keep the PostgreSQL dump and object list aligned. It writes `postgres.dump`, the object files, and `objects/manifest.json`. Store the directory off the server and protect it like the database: the API is public and the files may be sensitive.

Run `sh scripts/verify-restore.sh /absolute/path/to/backup` to create an isolated Compose project with fresh volumes, restore the dump and objects, and verify every active attachment's size and SHA-256 against PostgreSQL metadata. The isolated project and volumes are removed afterward. A nonzero exit means the backup was not verified. The script does not change the primary Compose project.

## Production prototype

Copy `.env.production.example` to `.env.production`, set distinct strong PostgreSQL and MinIO passwords, set `API_DOMAIN` to the public API hostname and `PWA_ORIGIN` to the exact HTTPS origin of the PWA. Point the API hostname's DNS at the server, allow TCP 80/443, then run `docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build`. Caddy obtains and renews HTTPS certificates. Only Caddy publishes host ports; API, PostgreSQL and MinIO stay on the private Compose network. Back up both volumes before upgrading. The API itself remains public and unauthenticated; deploy only a library whose contents can be exposed to anyone with its address.
