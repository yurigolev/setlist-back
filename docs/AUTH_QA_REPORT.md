# Telegram authentication and setlist QA report

**Date:** 2026-10-12

**Scope:** disposable local QA for Telegram OIDC authentication, legacy-data adoption, setlist collaboration API, and selected PWA flows. No production endpoint or credentials used.

## Result

The latest disposable backend run passed **22/22 automated tests, 0 failed, 0 skipped**, followed by **13/13 setlist API scenario groups**. Backend typecheck, build, and Drizzle migration consistency check passed. The latest frontend run passed **61/61 tests**, `vue-tsc` passed, and the production build passed. The runner cleaned up its isolated PostgreSQL, MinIO, and network resources. Evidence is in `/tmp/setlist-collaboration-gap-qa.log` and `/tmp/setlist-collaboration-frontend-epoch.log` on the QA host.

Browser acceptance now covers owner, viewer, and editor flows, including editor song deletion after confirming the browser's native confirmation dialog. The QA runner and browser evidence are local and disposable; this report does not claim real Telegram provider consent was newly tested.

## Automated backend evidence

The disposable stack used generated identities and data, a local mock OIDC issuer, PostgreSQL, and MinIO. The final run dynamically selected ports (the logged run used PostgreSQL `51852`, MinIO `51853`, API `51854`, and PWA origin `51855`) and removed its own containers and network at completion.

Migration/auth integration preserved legacy setlist, song, and attachment identifiers, object keys, revisions, and media bytes. The API suite verified auth boundaries and private responses; bootstrap adoption and replay; owner/editor/viewer permissions; setlist revision preconditions; invitation role and TTL constraints, hash-only storage, expiration, revocation, expiry while waiting for a lock, and single-use acceptance races; last-owner demotion races; exact setlist scoping and foreign-ID denials; idempotency isolation; independent song/media copies; deleted-setlist nested operation denial; and membership revocation or logout during slow uploads, including cleanup of incomplete objects. The script reports these as 13 scenario groups; see `scripts/qa-setlists-run.mjs`.

Migration preservation and `buildApp` protection checks are part of the backend automated suite. The additional API scenario group verifies invitation token hash-only storage, rejects TTL 169, rejects malformed setlist revision, checks successful revision increment, and denies nested writes after setlist deletion. The backend suite was run by `npm run test:qa`; typecheck, build, and `db:check` also completed successfully in the recorded final run.

## Browser evidence

Browser work used an isolated local QA stack and generated QA identities. It covered:

- Owner creates a setlist and song, copies a song to another setlist, and switches to an empty target setlist.
- Viewer follows an invitation fragment URL. The token is scrubbed from the URL, survives login and acceptance, then the viewer can read songs while song creation/edit/delete and administration controls are disabled.
- Editor follows an invitation, logs in and accepts it, creates and edits a song, and deletes it after accepting the browser's native confirmation dialog. Settings show editor access without administration controls. The API CORS fix for `PATCH`, `DELETE`, and preflight requests is included in automated regression coverage.
- In one browser profile, owner→viewer→editor account changes were exercised with logout/state checks. Earlier checks also passed cross-tab logout, private-cache clearing, and offline cached read-only access.

Browser checks used the local QA authorization path and do not represent real Telegram consent. Multiple real Telegram accounts and phone-browser behavior were not tested in this QA run. A previously working real Telegram flow is user-reported context only. Full browser restart isolation and referrer leakage inspection were not exercised. Frontend tests separately cover delayed responses, scope changes, targeted cache purge, reconnect membership refresh, and preservation of still-authorized scopes.

## Reproduction

Run the isolated backend QA suite with:

```sh
cd /Users/1g/WebstormProjects/setlist-back
npm run test:qa
```

The runner provisions an isolated stack, generates disposable credentials, rejects shared/default targets, and tears the stack down. For a persistent browser stack, use `npm run test:qa -- --serve`; it prints the selected ports and cleanup instructions. Configure the PWA proxy from those printed values. Do not assume fixed ports: preflight selects free loopback ports at runtime.

## Limits

- Telegram OIDC authorization and token verification use a local mock provider with ephemeral keys. Real provider consent was not newly exercised.
- Multiple real Telegram identities/devices and phone-browser flows remain untested.
- Full browser restart isolation and referrer leakage inspection remain untested. Scope changes and delayed responses have separate frontend test coverage; they were not all replayed as live browser scenarios.
- Automated API checks are not equivalent to full UI acceptance. See [SETLIST_QA_RISK_MATRIX.md](SETLIST_QA_RISK_MATRIX.md) for row-level status.

## Persistent refresh authorization verification (2026-10-12)

- Backend typecheck, build, ESLint and Drizzle migration check passed.
- Disposable `npm run test:qa -- --serve` passed 26 node tests and all 13 setlist API scenario groups, using only an isolated PostgreSQL/MinIO project. Production services were not changed.
- Refresh route coverage includes cold-start CSRF, wrong Origin, malformed/Unicode CSRF, expired access, one-use rotation, ten-second concurrency conflict, later replay family revocation, logout through refresh and legacy bootstrap restrictions. An additional targeted test verifies missing/malformed/expired refresh returns 401, creates no cookies and consumes no token.
- PostgreSQL migration/concurrency tests passed five consecutive targeted runs after teardown repair. Bootstrap checks the actual winning request; expiry testing observes a real family-lock wait through `pg_blocking_pids` before committing expiry. Existing session TTL survives migration; refresh expiry slides; replay and concurrent logout revoke all family access.
- Intermittent `terminating connection due to administrator command` came from verification database teardown racing PostgreSQL socket shutdown after `pg-pool.end()`. Cleanup now waits for that database's connections to disappear and drops only its generated verification database without FORCE.
- The existing setlist QA script was aligned with migration `0006_indefinite_invites`: legacy expiry dates no longer invalidate indefinite invitations. Revocation, one-use acceptance races and compatibility input bounds remain tested.

These results verify local disposable behavior. Production rollout and real Telegram provider credentials are separate deployment checks. A lost refresh response can require Telegram login after the concurrency grace window; the client preserves offline data in that case.
