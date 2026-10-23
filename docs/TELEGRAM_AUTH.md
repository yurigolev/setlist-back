> Historical Telegram documentation. Current local implementation: [YANDEX_AUTH.md](YANDEX_AUTH.md); future rollout: [YANDEX_PRODUCTION.md](YANDEX_PRODUCTION.md).

# Telegram authentication (local implementation)

The backend uses Telegram's current OIDC Authorization Code Flow, not the archived iframe widget. Configure the bot's Login Widget in BotFather with the exact website origin and callback URL; keep its signing algorithm **RS256**. Request scopes are `openid profile`. Documentation: https://core.telegram.org/bots/telegram-login .

## Configuration

- `TELEGRAM_CLIENT_ID`: BotFather client ID, server configuration.
- `TELEGRAM_CLIENT_SECRET`: BotFather client secret, server only.
- `TELEGRAM_REDIRECT_URI`: exact registered `/v1/auth/telegram/callback` URL.
- `PWA_ORIGIN`: exact application origin, without path or trailing slash.
- `AUTH_SESSION_TTL_SECONDS`: access lifetime; default 900 (15 minutes), range 60–2592000. Existing legacy sessions retain their original expiry.
- `AUTH_REFRESH_TTL_SECONDS`: sliding refresh lifetime; default 7776000 (90 days), range 60–31536000. Successful rotation starts this lifetime again.
- `TRUSTED_PROXY_CHAIN`: ordered Docker DNS proxy identities nearest API first (`frontend,caddy` in production, `pwa` in local Compose). Exact addresses and positions are verified before `request.ip` is used for login limits. Direct development leaves this empty and ignores forwarded headers. Production requires an explicit nonempty chain; details and spoofing checks are in `SAFE_RELEASE.md`.
- `AUTH_ALLOW_INSECURE_LOCAL_HTTP`: default false. Explicit true permits non-Secure cookies only when both application and callback use HTTP localhost,127.0.0.1 or[::1]. HTTPS requires Secure cookies.
- `LEGACY_OWNER_TELEGRAM_ISSUER` and `LEGACY_OWNER_TELEGRAM_SUB`: paired, explicit verified identity. Issuer must be `https://oauth.telegram.org`; subject is the token's opaque string `sub`, **not** numeric profile `id`, username or first login.

Missing Telegram credentials disable login and close access. New users start with no memberships and can create their own setlists. Legacy data remains inaccessible until an explicit local adoption command. Environment identity is bootstrap input only; it never grants API authority.

Local frontend requests should use its same-origin `/v1` development proxy. If cross-origin access is used, request credentials and the exact configured `PWA_ORIGIN` are required. Do not expose test dependency injection through HTTP routes or environment switches.

## API

1. Navigate the browser to `GET /v1/auth/telegram/start?returnTo=/`. Only internal relative application paths are accepted. The server saves a 10-minute one-use login attempt, binds it to an HttpOnly cookie, and redirects with state, nonce and PKCE S256.
2. Telegram returns to `GET /v1/auth/telegram/callback`. The server consumes the browser-bound attempt, exchanges the code using Basic client authentication and its saved PKCE verifier, then verifies the ID token's RS256 signature, issuer, audience, time claims and nonce. A successful callback issues access and refresh cookies and revokes the previous browser family.
3. `GET /v1/auth/session` returns `{user:{id,displayName,username?,picture?},csrfToken,refreshEnabled}` for valid access only. `refreshEnabled=false` identifies an unexpired legacy session. Cookies are opaque 256-bit random values; the DB stores only their SHA-256 hashes. `setlist_session` uses path `/`; `setlist_refresh` uses `/v1/auth`. Both are HttpOnly, SameSite=Lax and Secure outside explicitly enabled local HTTP.
4. After access expiry, `GET /v1/auth/refresh-context` returns the refresh family's profile and CSRF without renewing anything. Send exact `Origin: <PWA_ORIGIN>` and that `X-CSRF-Token` to `POST /v1/auth/refresh`. The server locks the family, consumes the refresh hash and issues a new pair atomically. Refresh never authorizes private content routes.
5. A repeated consumed refresh within ten seconds returns `409 REFRESH_CONFLICT` without issuing cookies: recheck the shared access cookie. A later replay revokes the family and all its access sessions. Missing, expired or revoked refresh returns 401. Network errors and 5xx do not establish expiry.
6. An unexpired legacy access cookie can call the same protected refresh endpoint to bootstrap its family once. Expired legacy sessions cannot bootstrap; access already belonging to a family cannot recreate a missing refresh. The original legacy access expiry is preserved for other tabs.
7. Send Origin and CSRF with every mutation, including `POST /v1/auth/logout`. Logout accepts either valid access or refresh, including expired access with valid refresh, returns 204, revokes the current family and clears cookies. Other devices retain their independent families.

The client owns automatic refresh in one `useAuthSession` composable, shares concurrent refresh, coordinates tabs and retries a confirmed 401 once. Expired authorization preserves the last user's offline cache; explicit logout clears private data. More than 90 days without refresh requires Telegram login again. Same-user login reuses cache after permission checks; another user cannot access it.

Callback failure redirects to fixed application `/login?authError=invalid` or `unavailable`; provider details, authorization codes and state are never included. Unconfigured login start redirects to `unavailable`. Auth responses use no-store. All canonical and legacy library/song/attachment routes require current database membership and use private,no-store, including rejected requests. Mutation transactions lock the active session row through commit: logout that wins before final authorization prevents publication; logout after authorization waits for the mutation.

Login initiation is limited to 20 requests per minute per IP per backend instance, with at most 10000 in-memory IP entries. Behind a proxy, the default untrusted forwarded-address policy can aggregate clients under its IP; do not blindly trust forwarded headers. Each new login removes up to 1000 expired login attempts; each new session removes up to 1000 expired sessions. Expired records never authorize requests. Retention cleanup is activity-driven and old expired records can remain while the service is idle.

## Local verification

Run `npm run typecheck`, `npm run build`, `npm run db:check` and `node --test dist/tests/auth-oidc.test.js`. OIDC tests inject signed local test keys and a fake token transport directly into the service; there is no test-login endpoint. Database/media integration must use a separate Compose project, fresh volumes and explicit unused ports. The retained CRUD/media/contract/migration suite now fails closed without explicit disposable QA fixtures: `AUTH_QA_PROJECT_NAME=setlist-auth-qa-*`, `AUTH_QA_DATABASE_NAME=setlist_auth_qa_*`, matching loopback `DATABASE_URL`, `AUTH_QA_PG_PORT`, `AUTH_QA_API_PORT`, `AUTH_QA_MINIO_PORT`, `TEST_API_URL`, plus `TEST_SESSION_COOKIE`, `TEST_CSRF_TOKEN` and `TEST_ORIGIN` from a valid owner QA login. It has no default mutation target. Run the full `npm test` only against this disposable environment; the QA harness supplies these values.

Migration 0003 creates auth tables/indexes. Migrations 0004–0005 add setlist metadata to the existing libraries table, membership, invitations and a durable legacy adoption marker. It leaves existing song IDs, attachment IDs, library revisions and object keys unchanged. Apply and rehearse migrations only in the isolated local test environment for this task. Real BotFather credentials and live Telegram consent have not been exercised.

## One-command disposable QA

After `npm ci`, run `npm run test:qa`. It generates synthetic credentials, starts a uniquely named Compose project with tmpfs PostgreSQL/MinIO, builds and migrates only its own database, completes signed mock Telegram login through the real start/callback/session endpoints, and runs the full `npm test`, including existing CRUD/media regressions. Migration rehearsal uses a second fresh database. It then stops its API process and removes only its own Compose project.

The command requires Docker Compose and allocates unused loopback ports for PostgreSQL, MinIO, API and application origin. Explicit port overrides must be unused. It ignores normal `.env` files and never uses port 3300 or existing volumes. The GitHub verify job runs this same command; publish/deploy jobs are unchanged. This command verifies server behavior; browser acceptance and real Telegram consent remain separately reported.

For a browser rehearsal, run `npm run test:qa -- --serve`. After tests, it retains its isolated API and tmpfs services until Ctrl-C. Use the API port and application origin printed by the runner for the frontend's `VITE_API_PROXY_TARGET` and preview port; do not assume fixed ports. The QA-only `/v1/auth/qa/authorize` page lets the browser select a synthetic identity without interception. Its signed mock provider still exercises the real callback, token verification and session flow. This page exists only in the isolated QA launcher, never in the production application.

## Persistent local Telegram stack

Use `npm run local:up` from `setlist-back` with Docker Desktop running. It builds the current API and the adjacent `../mobile-setlist` frontend, applies pending migrations, and waits for PostgreSQL, MinIO and API health. Open **http://127.0.0.1:46544**; this exact origin and `/v1/auth/telegram/callback` must be registered with Telegram. `localhost:5173` has a different cookie host and is not the login origin for this setup.

Secrets stay in ignored `.env.telegram.runtime.local`. The launcher derives ignored `.env.telegram.compose.local` with mode 0600. The Compose file has no credentials. Local ports: PostgreSQL 46641, MinIO 46642, API 46543 and PWA 46544, all bound to loopback.

`docker-compose.telegram.yml` uses external named volumes `setlist-telegram-pgdata` and `setlist-telegram-miniadata`; no tmpfs. Containers restart automatically with Docker (`unless-stopped`). PostgreSQL, users, sessions, memberships and uploaded files survive container recreation and Docker restart. `npm run local:stop` stops the stack deliberately; run `npm run local:up` to resume it. Even Compose `down -v` leaves these external volumes intact; explicit volume deletion or Docker factory reset can still destroy them.

MinIO's init service sets ownership on its data volume for the image's user (100:101). The API waits for healthy storage. An existing DB is migrated, never reset or seeded with a fake user. Legacy ownership is still a separate action after real verified Telegram login, using the explicit configured identity below.

Create a consistent DB + object backup outside Docker:

```sh
npm run local:backup -- /Users/1g/Backups/setlist-local-YYYY-MM-DD-HHMM
```

The destination must be new. Backup pauses the local API, writes `postgres.dump`, checksum manifest and object files, then restarts the API. `COMPLETE` marks a successful backup. Keep another copy outside this Mac for protection against disk failure. The backup contains private data, but does not contain Telegram credentials.

Recovery on 2026-10-21 copied the retained original local library into this separate stack: revision 193, 43 active songs and 57 attachments. Source backup: `/Users/1g/Backups/setlist-local-recovery-2026-10-21`. The original `setlist-back` volumes remain separate. Verified real Telegram login and restored ownership for the configured verified identity. Container recreation retained the session, two setlists and all 57 file checksums. A complete backup including auth state is in `/Users/1g/Backups/setlist-local-persistent-2026-10-21`. The old `setlist-auth-real-local-*` stack used tmpfs and must not be reused as persistent storage.

For host debugging only, `npm run start:telegram:local` still reads `.env.telegram.runtime.local` and serves API on 127.0.0.1:46543. Stop the container API first to avoid a port conflict. This launcher neither migrates nor adopts data; prefer `npm run local:up` for routine use.

## Collaborative setlists and local adoption

A song belongs to exactly one setlist. The existing `libraries` table is the physical setlist table; `songs.library_id` and `attachments.library_id` are its scope keys. Migration preserves original UUIDs, object keys and revisions. No first visitor receives the legacy setlist.

After the intended owner has completed verified authentication against the **isolated local database**, configure their exact verified `LEGACY_OWNER_TELEGRAM_ISSUER` and opaque `LEGACY_OWNER_TELEGRAM_SUB`, build, then run `npm run db:bootstrap-legacy`. The command accepts only a loopback database URL and resolves an existing `auth_users` row; absent identity fails without inserting any user. It locks the legacy scope and writes membership plus a durable adoption record atomically. Repeating with the same identity is a no-op, including after that original owner was later deliberately demoted or removed. A different identity fails. Nothing runs automatically on application startup or login. This task does not authorize production migration or adoption.

Current database membership controls access: owner manages members/invitations, renames/deletes the setlist and edits content; editor creates, edits and deletes songs/media; viewer reads/downloads. Membership changes serialize with content mutations on the setlist row. Removing or demoting the last owner returns 409. Upload verifies the live session and writer membership again after streaming, before publication; a failed final check cleans the temporary object.

Canonical routes live under `/v1/setlists/:setlistId`. Snapshot returns scoped song/media DTOs with scoped content URLs. Mutations require Origin and CSRF; song creation requires Idempotency-Key (independent per setlist), song updates/deletion and canonical media deletion require If-Match song revision; setlist update/deletion require setlist revision (initially 0). Missing/invalid revision format returns 428; revision conflict returns 409 with currentRevision. Legacy aliases refer only to the initial setlist and use its current membership; their media deletion retains the earlier header behavior.

Owner creates an indefinite editor/viewer invitation, valid until consumed or revoked. The optional legacy `expiresInHours` input is validated (1–168) for compatibility but does not limit the invitation. Only the creation response includes its random token; lists expose metadata only, storage contains a hash. Send the token in the authenticated CSRF-protected `POST /v1/invitations/accept` JSON body, never a URL. Acceptance consumes once atomically and preserves existing membership authority. Revoked, expired, consumed or deleted-scope invitations fail.

`POST /v1/setlists/:sourceId/songs/:songId/copy` with `{targetSetlistId}` requires source read and target write. It allocates fresh song/media UUIDs and independent MinIO objects, keeps source content intact, and returns the copied song with attachments. Opposite-direction copies lock scopes in sorted order. Failure rolls back metadata and removes copied objects. Editing/deleting either copy never edits the other.

Access errors distinguish revoked/missing membership (`403 SETLIST_ACCESS_DENIED`) from insufficient current role (`403 SETLIST_ROLE_REQUIRED`). Clients should preserve readable scope after a role-only error and refresh its confirmed role. `403 CSRF_INVALID` does not indicate revocation. Missing/deleted scopes return `404 SETLIST_NOT_FOUND`.

## Refresh rollout

Apply migration `0007_refresh_sessions.sql` before deploying the refresh backend, then release the matching client. Nullable `auth_sessions.family_id` preserves existing sessions. Update both TTL environment values explicitly: existing environment configuration overrides defaults. Production deployment and migration require their separate authorization. Rollback may leave the additive tables in place; a pre-refresh backend cannot renew the new sessions.
