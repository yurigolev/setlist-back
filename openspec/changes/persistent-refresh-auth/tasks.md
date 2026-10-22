## 1. Серверная авторизация

- [x] 1.1 Добавить конфигурацию TTL, семейства refresh и миграцию с nullable familyId для legacy access.
- [x] 1.2 Реализовать выдачу пары, refresh-context, ротацию и replay revoke, защищённый legacy bootstrap и logout семейства.
- [x] 1.3 Обновить OpenAPI, env examples и документацию.

## 2. Проверки

- [x] 2.1 Security tests Origin/CSRF, истечения, ротации, replay, logout и legacy.
- [x] 2.2 Проверить миграцию и конкуренцию на disposable PostgreSQL, выполнить build и QA.
