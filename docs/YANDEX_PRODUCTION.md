# Yandex for setlivo.ru

Yandex replaces Telegram authentication. Merge/push to `main` triggers automatic publication/deployment. Install the reviewed configuration and take a fresh consistent backup before merging release PRs.

Register an application for user authorization with web platform and `login:info`. Callback addresses:

- `https://setlivo.ru/v1/auth/yandex/callback`
- `http://127.0.0.1:46544/v1/auth/yandex/callback` for local verification

Keep client credentials only in private config, never Git or frontend. The optional local source is `/Users/1g/.config/setlivo/yandex.env` (0600). The private server env must retain all current database/MinIO credentials and image SHAs while adding `YANDEX_CLIENT_ID`, `YANDEX_CLIENT_SECRET`, `YANDEX_REDIRECT_URI`, `PWA_ORIGIN=https://setlivo.ru` and session TTLs. Production requires secure cookies and the exact same-origin HTTPS callback.

The API Compose temporarily passes optional `TELEGRAM_CLIENT_ID`, `TELEGRAM_CLIENT_SECRET` and `TELEGRAM_REDIRECT_URI` from the existing private env. Preserve all three unchanged during the rollback window: the previous image needs them for backup commands and image rollback. The Yandex runtime ignores these values and exposes no Telegram login routes. Remove this compatibility bridge only after the previous release is no longer a rollback target.

The new Compose uses direct HTTPS to Yandex; Telegram proxy settings and JWKS are not used. Preflight validates Yandex config and public endpoint responses from the actual new API image before backup/restart. This proves routing/TLS, not real user login.

Before a future release, preserve old images, Compose, deploy script and env together, rehearse one complete backup, and follow [SAFE_RELEASE.md](SAFE_RELEASE.md). Confirm real login and verified Yandex identity before explicit owner plan/apply. Never copy the old local UUID or auto-link by login/email. Existing Telegram memberships remain untouched and require a separately reviewed transfer if already assigned.

Rollback to Telegram requires compatible old frontend/backend, old Compose/env and working Telegram network access. Image rollback alone does not restore provider config or revert database changes. No new SQL migration is introduced by this replacement.
