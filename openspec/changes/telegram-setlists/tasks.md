## 1. Независимый вход и сессия

- [x] 1.1 Реализовать Telegram code+PKCE/state/nonce и проверки подписанного ID token, одноразовые browser-bound grants.
- [x] 1.2 Реализовать additive auth migration, hashed sessions store, /v1/auth/session, CSRF+Origin и logout.
- [x] 1.3 Закрыть все legacy API и файлы owner-only по явному issuer/sub; fail closed без owner config.

## 2. Приватный клиентский контекст

- [x] 2.1 Предоставить стабильный auth session DTO и exact-origin credentialed CORS для frontend.
- [x] 2.2 Выдавать no-store для приватных API/media и безопасный verified profile.
- [x] 2.3 Обеспечить session revocation и повторную owner/session проверку в конце upload transaction.

## 3. Совместные сет-листы

- [x] 3.1 Зафиксировать утверждённую модель SONG 1:N SETLIST, независимое копирование, роли и согласованный scoped API в существующих артефактах.
- [x] 3.2 Реализовать server setlists CRUD, membership owner/editor/viewer, scoped song/media permissions и клиентский выбор/создание/настройки сет-листа.
- [x] 3.3 Реализовать invitations hash/TTL/revoke/atomic acceptance, UI участников и ролей, безопасную ссылку с входом перед принятием.
- [x] 3.4 Реализовать независимое копирование песни и файлов, защитить foreign IDs, last-owner concurrency и upload finalization после отзыва.
- [x] 3.5 Завершить additive legacy adoption: явный verified existing issuer/sub, durable bootstrap marker, сохранение IDs/keys/revisions без постоянного env owner bypass.
- [x] 3.6 Изолировать клиентский cache по user+setlist и закрыть switch/download/mutation/stale403 races; offline выбранного scope только для чтения.

## 4. Проверка и локальная репетиция

- [x] 4.1 Сохранить выполненные auth OIDC/session/CSRF/logout unit и integration проверки.
- [x] 4.2 Сохранить ранее выполненную изолированную auth PostgreSQL/MinIO миграцию с исходными IDs/objectKeys.
- [x] 4.3 Сохранить ранее выполненный browser mock OIDC auth/logout/outsider flow; реальный Telegram вход подтверждён пользователем, новый consent отдельно не заявлять.
- [x] 4.4 Выполнить полный disposable migration/API/browser role+invite+copy+IDOR+revocation+offline+cache matrix, исправить найденные ошибки и повторить проверки.
- [x] 4.5 Обновить OpenAPI/локальные инструкции/QA report для итоговой модели; выполнить build/tests/strict OpenSpec validate и diff review без commit/push.
