## Context

См. proposal.md. Telegram OIDC, серверные сессии, CSRF и приватный клиентский контекст уже реализованы локально. Пользователь утвердил SONG 1:N SETLIST: песня принадлежит ровно одному сет-листу; повторное использование создаёт независимую копию. Все текущие незакоммиченные изменения сохраняются.

## Goals / Non-Goals

**Goals:** завершить серверную модель, роли, приглашения, копирование и пользовательский выбор сет-листа; сохранить старые песни и файлы; проверить миграцию и полный путь локально.

**Non-Goals:** production, commit/push/deploy, деструктивный откат БД, принудительное удаление ранее скачанных сторонних копий файлов.

## Decisions

1. Сохраняется Telegram OIDC Authorization Code Flow: PKCE S256, state, nonce, серверный Basic exchange, RS256 JWT с issuer/aud/exp, scopes openid/profile. Идентичность — проверенная пара issuer/sub, не клиентский profile.id. Opaque cookie HttpOnly/SameSite=Lax/Secure для HTTPS, hash сессии и TTL в БД; mutations требуют exact Origin и X-CSRF-Token. Auth/private responses no-store.
2. Сет-лист представлен существующей физической таблицей libraries с добавленными title/updatedAt/deletedAt, без второй конкурирующей области данных. songs.library_id — обязательная единственная FK сет-листа; attachments.library_id/song_id согласованы. Так сохраняются исходные UUID/revisions/objectKeys без M:N и переноса данных в новую параллельную библиотеку.
3. Membership связывает setlist и внутренний auth user с owner/editor/viewer. Owner управляет сет-листом и доступом; owner/editor выполняют весь song/media CRUD, включая удаление; viewer читает/скачивает. Все маршруты проверяют конкретный setlist и принадлежность вложенных ID. Членство в одном сет-листе не выдаёт доступ к другому. Legacy aliases допускают только membership фиксированного initial LIBRARY_ID, не применяют постоянный env owner bypass.
4. Mutations, изменение членства, last-owner проверки, удаление сет-листа и принятие приглашения сериализуются блокировкой строки одного сет-листа; при операциях двух сет-листов используется стабильный порядок блокировок. TTL после ожидания блокировки проверяется по фактическому текущему времени (clock_timestamp), а не времени начала транзакции. Session recheck и актуальная роль проверяются внутри финальной транзакции, upload повторяет проверку после stream. Soft deletion закрывает snapshot/media/invitation acceptance. Откат приложения не откатывает БД.
5. Random invitation token хранится hash-only; expires/revoked/used состояния и атомарное принятие после login с CSRF дают одного успешного получателя. Invite предлагает editor/viewer; owner выдаётся только изменением существующего участника. Принятие не понижает текущую роль. Ссылка /invite#token=... не отправляет секрет в HTTP path; клиент сразу очищает fragment, сохраняет токен только в tab sessionStorage и передаёт через login безопасный internal returnTo=/invite без секрета; применяет no-referrer и удаляет секрет после принятия. Логи не содержат body/token/query/fragment.
6. Копирование проверяет чтение исходника и запись в получателе, создаёт новые song/attachment UUID и отдельные MinIO objectKeys для всех файлов. Общие objectKeys исключены: удаление исходника не ломает копию. При финальном отказе копирование не публикует rows, временные объекты очищаются.
7. Клиент использует immutable user+setlist scope для IndexedDB и каждого async запроса. Switch/logout/revocation сбрасывают RAM, object URLs, активный view и generation; поздний snapshot/download/mutation не сохраняет и не публикует данные нового контекста. Старый anonymous cache не присваивается. API/media не входят в общий Workbox cache; /v1,/health,/openapi.yaml исключены из navigate fallback.
8. Offline показывает только последнюю подтверждённую локальную идентичность и выбранный подтверждённый setlist в режиме чтения. Явный 401 текущего session generation сбрасывает сессию и все приватные данные. Подтверждённый отказ доступа к текущему setlist очищает только его контекст; stale403 прежнего scope не затрагивает новый, CSRF_INVALID не считается отзывом. SETLIST_ROLE_REQUIRED означает недостаточную роль действующего участника: клиент обновляет роль, сохраняя чтение и кэш. SETLIST_ACCESS_DENIED означает отсутствующее членство: очищается только совпадающий scope. При успешном online списке доступных сет-листов клиент сравнивает known scopes и удаляет кэш отозванных/удалённых сет-листов, включая невыбранные, сохраняя остальные; очистка защищена поколением user context. Logout очищает private caches/remembered identity и синхронизируется между вкладками.
9. Аддитивная миграция не назначает первого посетителя владельцем. Явная локальная bootstrap команда принимает заранее проверенные issuer/sub и разрешает только существующего verified auth_users пользователя. Отсутствующая identity отклоняется. Durable adoption marker предотвращает захват, повторное присвоение и восстановление намеренно отозванной роли. После успешного adoption права зависят только от membership, owner env можно удалить.

### API contract

- Auth остаётся GET /v1/auth/telegram/start?returnTo=<internal>, GET callback, GET session -> {user:{id,displayName,username?,picture?},csrfToken}, POST logout ->204.
- SetlistDTO: {id,title,revision,createdAt,updatedAt,deletedAt:null,role}. GET /v1/setlists -> {setlists}; POST {title} -> DTO. PATCH /v1/setlists/:setlistId {title}, DELETE с If-Match.
- GET /v1/setlists/:setlistId/snapshot -> {setlistId,setlistRevision,role,songs}. SongDTO и AttachmentDTO сохраняют текущие поля и добавляют setlistId; contentUrl scoped. Song/media маршруты вложены в /v1/setlists/:setlistId: /songs, /songs/:songId, /songs/:songId/attachments, /attachments/:attachmentId[/content]. Существующие If-Match, Idempotency-Key, X-Attachment-Id сохраняются; DELETE attachment требует If-Match текущей родительской песни.
- GET /:setlistId/members -> {members:[{user:{id,displayName,username?,picture?},role,createdAt}]} доступен любому участнику; PATCH /members/:userId {role} и DELETE /members/:userId доступны только owner.
- GET /:setlistId/invitations -> {invitations:[{id,role,expiresAt,createdAt,revokedAt,usedAt}]}; POST {role:'editor'|'viewer',expiresInHours:1..168} -> {invitation,token}; DELETE /invitations/:invitationId отзывает. POST /v1/invitations/accept {token} -> {setlist:DTO}.
- POST /v1/setlists/:sourceId/songs/:songId/copy {targetSetlistId} -> SongDTO независимой копии; исходное состояние согласовано под блокировкой source scope, If-Match/Idempotency-Key не требуются, повторный POST создаёт новую копию.
- Нет session ->401; отсутствующий/некорректный If-Match ->428 REVISION_REQUIRED; конфликт ->409 REVISION_CONFLICT с currentRevision; 403 SETLIST_ROLE_REQUIRED — недостаточная роль, 403 SETLIST_ACCESS_DENIED — отсутствующее членство; конкретные scope отказ/чужой ID не раскрывают чужие данные. Setlist revision допускает0.

## Risks / Trade-offs

- Уже скачанные файлы остаются у пользователя → отзыв немедленно закрывает последующие серверные операции, включая финализацию upload.
- Устаревший async ответ либо stale403 → immutable scope + session/scope generation guards перед очисткой/записью/публикацией.
- Тесты могли бы мутировать рабочую БД → уникальный compose project, свободные порты, новые volumes; существующий локальный Telegram stack не останавливается.
- Реальный Telegram вход подтверждён пользователем → локальные OIDC mocks и роли проверяются отдельно; новый внешний consent без фактического прохождения не заявляется.
- Copy требует дополнительного storage → независимость данных важнее дедупликации, временные объекты очищаются при отказе.

## Migration Plan

1. Применить additive migration только к disposable предыдущей схеме; сохранить UUID, revisions, objectKeys, metadata и содержимое исходных объектов.
2. Проверить посторонний первый вход, отсутствующую verified owner identity, явный bootstrap, idempotence и replay после снятия полномочий; production scripts не запускать.
3. Проверить role matrix, concurrent last-owner/invitation acceptance, IDOR, upload revocation и независимость copy.
4. Проверить frontend multiuser/invite/switch/offline/cache races/logout через изолированные API/UI.
5. Сохранить код и миграцию локально; down migration, commit, push, production deploy не выполняются.
