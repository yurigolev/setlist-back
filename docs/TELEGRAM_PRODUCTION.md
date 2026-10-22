# Telegram для setlivo.ru

Подготовлено локально 22 октября 2026. Production-конфигурация и приложение на сервере не менялись.

## Что подготовлено

- `.env.telegram.production.local` — приватный фрагмент production env с теми же Client ID/Secret, что в рабочем локальном Telegram-конфиге. Значения не публикуются в документации. Права файла `600`; Git и Docker его исключают.
- `PWA_ORIGIN=https://setlivo.ru`, callback `https://setlivo.ru/v1/auth/telegram/callback`, secure cookies, access 900 секунд, refresh 7776000 секунд.
- `backups/telegram-setlivo-20261022/intended-owner.json` — приватная ожидаемая Telegram identity владельца `@golev_yu`, найденная по настроенным issuer/subject в локальной `auth_users`. Файл содержит reference на локальный UUID; `productionUserId` пока `null`. Права `600`, каталог исключён из Git/Docker.
- Production Compose и runtime проверены с подготовленными значениями без подключения к БД, Telegram или MinIO. Это проверка конфигурации, не реального production-входа.

В env также сохранены `LEGACY_OWNER_TELEGRAM_ISSUER`/`LEGACY_OWNER_TELEGRAM_SUB` как ожидаемая identity. Они сами не назначают membership; production Compose не передаёт их работающему API. Назначение остаётся отдельной операцией `plan → apply`.

## Что настроить в BotFather

Открыть mini app [@BotFather](https://t.me/BotFather), выбрать **того же бота, который используется локально**, затем **Login Widget**.

В **Redirect URIs** добавить точную запись:

```text
https://setlivo.ru/v1/auth/telegram/callback
```

В **Trusted Origins** добавить `https://setlivo.ru`. Существующие локальные записи оставить: origin `http://127.0.0.1:46544` и redirect `http://127.0.0.1:46544/v1/auth/telegram/callback`. В **Login Widget → Advanced** выбрать **RS256**. Client ID и Client Secret оставить текущими. Приложение запрашивает `openid profile`.

22 октября пользователь подтвердил настройку production URL и RS256 в BotFather. Реальный production-вход остаётся проверкой после выпуска backend.

Названия разделов и требования сверены с [официальной документацией Telegram Login](https://core.telegram.org/bots/telegram-login) 22 октября 2026.

## Следующий шаг при согласованном выпуске

Подготовленный env — фрагмент. Его Telegram/PWA/TTL значения нужно внести в существующий приватный `/opt/setlist/.env.production`, сохранив текущие DB/MinIO credentials, image SHA и остальные серверные параметры. Сам фрагмент не заменяет полный серверный env. Использовать по [SAFE_RELEASE.md](SAFE_RELEASE.md) в отдельное окно выпуска.

После выпуска backend владелец входит на `https://setlivo.ru` своим Telegram-аккаунтом. Его production UUID берётся из собственной `/v1/auth/session`; локальный UUID переносить нельзя. Затем создаётся read-only план назначения.

Перед apply сравнить identity плана с подготовленной identity. На машине, где находятся оба приватных JSON, выполнить:

```sh
node --input-type=module - backups/telegram-setlivo-20261022/intended-owner.json /absolute/path/to/legacy-owner-plan.json <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const [identityPath, planPath] = process.argv.slice(2);
const expected = JSON.parse(readFileSync(identityPath, 'utf8'));
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
assert.equal(plan.owner.issuer, expected.issuer, 'Owner issuer mismatch');
assert.equal(plan.owner.subject, expected.subject, 'Owner subject mismatch');
assert.equal(plan.library.id, expected.libraryId, 'Legacy library mismatch');
console.log('Intended Telegram owner and legacy library match');
JS
```

Сверять issuer/subject, а не username: username может измениться. Production UUID, target БД и ревизию дополнительно проверяет штатный owner plan/apply. После назначения проверить песни, вложения и отказ доступа постороннему аккаунту, затем выпускать frontend. До выпуска backend production callback ещё не обслуживается новой авторизацией; реальный вход сейчас не проверялся.
