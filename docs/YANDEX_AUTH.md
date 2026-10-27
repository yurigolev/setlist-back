# Yandex authentication and local verification

The active provider is Yandex ID. The API uses authorization code + S256 PKCE, validates the one-use state and browser cookie, exchanges the code server-side at `https://oauth.yandex.ru/token`, and requests JSON at `https://login.yandex.ru/info?format=json` with an `Authorization: OAuth` header. Both requests verify TLS, reject redirects and have a five-second timeout. The exact returned `client_id` must match the configured client and `id` must be a nonempty string. Identity namespace is `https://login.yandex.ru`; the subject is the server-verified Yandex `id`. Names and email are never identity keys.

The provider access token is neither sent to the browser nor stored. The API creates its own HttpOnly session/refresh cookies, retains CSRF and refresh rotation, and checks setlist membership on every private request. Login never grants access to old data.

## Persistent local Yandex stack

Configure ignored `.env.yandex.runtime.local` with the variables in `.env.example`, local PostgreSQL/MinIO credentials and server-only `YANDEX_CLIENT_ID` / `YANDEX_CLIENT_SECRET`. Register the exact callback `http://127.0.0.1:46544/v1/auth/yandex/callback` in the Yandex web application and grant `login:info` and `login:avatar` (user profile picture).

The API maps a nonempty Yandex `default_avatar_id` to a public `https://avatars.yandex.net/get-yapic/<id>/islands-200` URL in the session user's `picture`. Missing or placeholder portraits keep the initials fallback. After enabling portrait access and updating the API, sign out and sign in through Yandex again: existing sessions and refreshes do not fetch a new provider profile.

Local endpoints: PWA `127.0.0.1:46544`, API `127.0.0.1:46543`, PostgreSQL `127.0.0.1:46641`, MinIO `127.0.0.1:46642`. Use `PWA_ORIGIN=http://127.0.0.1:46544`, that exact callback, and `AUTH_ALLOW_INSECURE_LOCAL_HTTP=true`. Never reuse these insecure cookie settings for production.

```sh
npm run local:up
npm run local:stop
npm run local:backup -- /absolute/path/to/new-backup
```

`local:up` derives ignored `.env.yandex.compose.local` with mode 0600 and builds the adjacent frontend. Project `setlist-yandex` uses persistent external volumes `setlist-yandex-pgdata` and `setlist-yandex-miniadata`. The previous Telegram stack and its volumes stay separate. Stop any old stack occupying the same loopback ports first. No automatic data seeding, identity linking or owner adoption occurs.

Backup pauses the local API, writes one consistent database/object snapshot and a `COMPLETE` marker, then restarts the API. Backup contents are private. Host debugging uses `npm run build` then `npm run start:yandex:local` while the container API is stopped.

## Explicit old-library ownership

After real login to the local copy, read the account UUID from your own `/v1/auth/session`. Create a plan with `node dist/ops/legacy-owner.js plan UUID /private/new-plan.json`. Review the exact database, Yandex issuer/subject, old library ID, revision and absence of conflicting rights; apply that same plan with `node dist/ops/legacy-owner.js apply /private/new-plan.json`.

The CLI accepts only verified Yandex users. Existing Telegram users with the same subject remain distinct. A library already adopted by a Telegram account is not automatically reassigned; that requires a separate explicitly verified account-transfer procedure. Replaying an adoption never restores a deliberately removed/demoted owner. Do not edit historic migrations to change identity provider.

## Verification

`npm run test:qa` creates only its own disposable tmpfs PostgreSQL/MinIO project and synthetic credentials. The mock HTTP provider exercises the real Yandex adapter and code/PKCE/profile checks; it is not real user consent. It runs API, session, refresh, permission, media and migration regressions plus setlist scenarios. `npm run test:proxy` checks independent client-IP rate limits and forged forwarding headers through Caddy/Nginx. Real browser login must be verified separately before rollout.

Official references: [code flow](https://yandex.ru/dev/id/doc/ru/codes/code-url), [profile API](https://yandex.ru/dev/id/doc/ru/user-information), [application registration](https://yandex.ru/dev/id/doc/ru/register-auth).
