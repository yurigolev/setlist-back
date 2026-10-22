# Auth and multi-user QA plan

## Current baseline

- The current API exposes a single fixed library. It has no account, session, invitation, membership, or role boundary yet.
- Backend API tests target a running `TEST_API_URL` (default `http://127.0.0.1:3000`) and mutate songs, attachments, and object storage. Never point these tests at the shared local stack.
- The migration test creates and drops a database using the configured database URL. It is unsafe against a shared database unless run only inside a dedicated disposable database service.
- The PWA keeps one `setlist-library` IndexedDB database with server snapshots and files. Existing metadata is keyed by library, with no account identity or logout cleanup.
- Current backend integration tests cover song revisions, idempotency, attachment integrity, and object cleanup. They do not cover any auth or tenant boundary.

## Test suites after auth implementation

### Telegram OIDC

Use a local mock OIDC issuer with a test-only generated signing key and injected HTTP/JWKS transport. Exercise the real callback and session code, without a test-login endpoint or bypass.

- Successful start/callback creates a session and returns to a relative path; verify state, nonce, and PKCE binding.
- Reject mismatched state, nonce, PKCE verifier, signature, issuer, audience, expired `exp`, future/invalid `iat`, and malformed token claims.
- Reject replayed or consumed login grants and ensure callback failures do not issue a session cookie.
- Session cookie is HttpOnly, SameSite=Lax, and Secure according to config; session storage contains only a token hash.
- `GET /v1/auth/session` returns the user and CSRF token for a valid cookie and 401 for absent, expired, revoked, or unknown sessions.
- Logout requires same-origin `Origin` and valid CSRF token, revokes the server session, and clears the cookie. Reuse of the prior cookie returns 401.

### Invitations, roles, and tenant boundaries

- User A cannot read, mutate, or fetch attachment content belonging to user B, even when guessing song, setlist, or attachment IDs.
- Viewer can read permitted setlists but cannot create/edit/delete songs or attachments.
- Editor can create and edit songs and attachments, but cannot delete or administer membership.
- Owner can administer invitations and memberships. Owner-only deletion and membership protections follow the released contract.
- Expired, revoked, already-used, and wrong-account invitations cannot be accepted; an active invitation can be accepted once and grants only the specified role.
- Unauthenticated API requests return 401, including attachment content routes and conditional write routes.

### Legacy data migration

Run old migrations on an isolated database, insert representative legacy users/libraries/songs/attachments, then apply the new migration. Assert all legacy song, attachment, library/setlist IDs, revisions, timestamps, and `object_key` values remain unchanged; verify object bytes by fetching through the isolated MinIO instance. Assert the designated legacy owner gets access and unrelated users do not. Check migration idempotence only if the migration runner contract supports re-entry; do not claim binary rollback safety after the private API migration.

### Offline and account switching

- After account A syncs, logout and account B login on the same browser profile. Verify A's song metadata and files are unavailable both online and offline.
- Repeat A → B → A, browser restart, offline launch, and service-worker update scenarios.
- Verify no authenticated API response or private attachment is served from the service-worker HTTP cache to a different account.
- Verify incomplete/failed snapshot publication never exposes a mixture of accounts or partial files.

### Local UI flow

With the isolated API and mock OIDC issuer, exercise sign-in, callback, session display, invitation acceptance, role-based controls, logout, and offline account switching in the actual PWA. Keep the production Telegram issuer and credentials out of the test environment.

## Isolation requirements

- Give the QA Compose project a unique project name, explicit unused host ports, and newly named volumes. Never reuse or remove the existing `setlist-back` / `mobile-setlist` project or volumes.
- Point all API and browser tests only at those explicit QA ports. Do not rely on the backend test default URL.
- Use a disposable PostgreSQL service for migrations. Never run the create/drop migration test against the shared local PostgreSQL or production.
- Use a disposable MinIO volume and generated throwaway credentials. Do not read `.env` or `.env.local` values into logs or test output.
- Keep the mock issuer key, audience, and redirect URI local to the test process. Do not add a login bypass or production test mode.

## Current harness gaps

- Backend integration tests are coupled to an already-running API; auth route tests need an isolated Fastify instance with injected `AuthConfig`, `AuthStore`, and OIDC transport.
- Database migration coverage needs an explicit disposable database URL and an old-schema fixture before the new migration is applied.
- The browser flow was manually accepted through production Vite preview with an active service worker and a locally signed RS256 identity token. A single-command runner for repeatable browser automation remains separate work.
- Frontend tests should run with `VITE_API_BASE_URL=''` so a developer's local `.env.local` cannot redirect tests to the shared API.

## Local QA execution

The isolated Compose project used PostgreSQL `46531`, MinIO `46532`, API `46533`, and production PWA preview `46534`. PostgreSQL and MinIO used temporary in-memory filesystems; no existing project containers or volumes were reused.

`node --test dist/tests/auth-integration.test.js` passed against a generated child database after replaying the pre-auth migrations. The test preserved the legacy library ID/revision, song ID/revision, attachment ID, object key, checksum, and MinIO bytes across the additive auth migration. The actual `buildApp` routes returned 401 without a session, 403 for an unrelated Telegram identity, 200 for the configured owner, and 201 for an owner song write; snapshot and media responses carried private no-store headers. After logout the same session received 401.

In the browser, the PWA production worker controlled the page before sign-in. The browser intercepted only the Telegram authorization page; the real API callback exchanged a locally generated RS256 ID token through `createTelegramOidc`. Both `/start` and the same-origin `/callback` reached the API through the PWA preview proxy. The owner saw the preserved song in two tabs, then logout in one tab cleared both tabs and deleted the user's IndexedDB database. Reloading offline reopened the precached PWA and showed the owner's saved songs in read-only mode. A second signed-in identity received the owner-denied screen with no song data and no private IndexedDB database.

Real Telegram network login and collaborative setlist roles/invitations were not exercised: the former needs real provider credentials, and the song/setlist relationship is still awaiting a user decision.
