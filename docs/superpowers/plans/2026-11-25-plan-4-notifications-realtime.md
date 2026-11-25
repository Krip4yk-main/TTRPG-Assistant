# НРІ Асистент — План 4: Сповіщення, планувальник, реальний час, Telegram-бот

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Користувачі отримують сповіщення про все важливе (заявки, учасники, сесії, нагадування) у застосунку в реальному часі та в Telegram; бот дозволяє діяти прямо зі сповіщення; оновлення на відкритій сторінці видно без зсуву інтерфейсу; нове/непереглянуте позначається.

**Architecture:** Фоновий планувальник у процесі бекенду на таблиці `jobs` (`SELECT … FOR UPDATE SKIP LOCKED`, опитування раз на 5 с). Таблиця `events` (План 3) — outbox: періодична задача-диспетчер бере ще не оброблені події (`events.dispatched_at IS NULL`, `FOR UPDATE SKIP LOCKED` — курсор за id небезпечний: id видаються до коміту, тож «пізні» коміти пропускалися б) і створює `notifications` отримувачам. Доставка: Socket.IO-подія `notification.new` у кімнату `user:<id>` + рядок у `telegram_outbox`; бот забирає пачки через внутрішній API і рендерить тексти зі своїх i18n-файлів. Зміни даних на сторінках — «пінги без даних» у кімнати `game:<id>` (право на кімнату перевіряє сервер); клієнт сам перезапитує API (видимість лишається на сервері).

**Tech Stack:** як у Плані 3. Нових залежностей немає.

**Spec:** `docs/superpowers/specs/2026-11-24-nri-assistant-design.md` (§6) + `docs/superpowers/backlog.md` (розділ «План 4»).

## Рішення (ухвалені без власника — див. NIGHT-REPORT.md, можна змінити)

- Канали: у застосунку — завжди; Telegram — якщо прив'язано й категорія увімкнена; email — ні (спек).
- Категорії: `applications`, `members`, `sessions`, `reminders`, `games`. Telegram-перемикач на кожну (за замовчуванням увімкнено).
- Нагадування перед сесією: за замовчуванням [24 год, 1 год]; вибір з {15 хв, 1 год, 3 год, 24 год, 48 год}; порожній список = вимкнено. Отримувачі: майстер і активні учасники. Скасовані сесії не нагадуються; перенесена — нагадується за новим часом.
- Подяка після завершення гри — у застосунку й Telegram, текст за жанром (`thanks.<genre>`), без заклику до донату (донати — пізніше).
- Telegram-кнопки: «Затвердити / Відхилити» на новій заявці (майстру); «Я буду / Не зможу» на нагадуванні (RSVP). Бекенд перевіряє права за Telegram-ідентичністю.
- RSVP — нова таблиця `session_rsvp(session_id, user_id, status going|not_going, updated_at)`; доступно й у застосунку.
- `isViewed`: `entity_views(user_id, entity_type game|application|session, entity_id, viewed_at)`; DTO отримують `seen: 'new'|'updated'|'seen'`.
- Оновлення на сторінці: фіксований банер «Є оновлення — оновити» (не зсуває контент), після оновлення — підсвітка змінених елементів.
- Планувальник: повтори з експоненційною затримкою (до 5 спроб, потім `failed`). Щоденно 03:00 UTC: матеріалізація сесій активних ігор; видалення `pending`-користувачів, старших 7 днів, без заявок/ігор; чистка прочитаних сповіщень, старших 90 днів. Кожні 5 хв: нагадування, перевалідація сокетів.
- Нагадування рахуються «вікнами» з журналом `reminder_log` (UNIQUE(session_id, user_id, offset_min)) — стійко до переносів і повторних запусків.

## Global Constraints
- Як у Плані 3: компоненти .ts/.html/.less; тексти — `uk.json` (фронт) і `bot/src/i18n/uk.json` (бот); коди помилок перекладені; контракти — в `@nri/shared`; права — на бекенді; час у БД — UTC.
- Жодна приватна інформація не йде в Socket.IO-пінги; повні дані — лише через API з перевіркою видимості.
- Тексти Telegram — без HTML-ін'єкцій (`parse_mode` не використовується або всі значення екрануються).
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build -w frontend` — зелені перед комітом; форматувати лише змінені файли.

## Review Focus
1. **Подвійна доставка:** два воркери/повторний запуск диспетчера не створюють дублікатів сповіщень/нагадувань/Telegram-повідомлень (унікальні ключі). Тест — Task 1–3.
2. **Нагадування після переносу/скасування:** скасована сесія — без нагадувань; перенесена — нагадування за новим часом, старі не надсилаються. Тест — Task 3.
3. **Підробка дії з Telegram:** callback від Telegram-акаунта, не прив'язаного до майстра гри, не затверджує заявку. Тест — Task 5.
4. **Витік через пінги:** колишній учасник не може приєднатися до кімнати `game:<id>`; пінги не містять полів гри. Тест — Task 6.
5. **Налаштування:** вимкнена категорія Telegram не створює рядків `telegram_outbox`; користувач без Telegram — теж. Тест — Task 2/4.

---

### Task 1: Планувальник задач
**Files:** `backend/src/db/schema/jobs.ts` (+міграція), `backend/src/jobs/{queue,worker,registry}.ts`, `backend/src/server.ts` (старт/зупинка воркера), tests `backend/test/jobs/*.test.ts`.
**Interfaces:** `jobs(id, type varchar(64), run_at, payload json, status pending|running|done|failed, attempts, last_error, locked_until, unique_key varchar(191) null UNIQUE)`; `enqueue(deps, {type, payload, runAt?, uniqueKey?})` (дубль `uniqueKey` → no-op); `registerHandler(type, fn)`; `startWorker(deps, {pollMs=5000})` → `{stop()}`; періодичні задачі — `scheduleRecurring(type, everyMs | dailyAtUtc)` реалізовано як самопереплановування (handler після виконання ставить наступний запуск з `uniqueKey` = `type@<runAt>`). Воркер не запускається в `NODE_ENV=test`, тести викликають `runDueJobs(deps, now)`.
- [ ] Тести: два паралельні `runDueJobs` виконують задачу один раз; помилка → повтор з затримкою, після 5 — `failed`; `uniqueKey` дедуплікує; самопереплановування не дублює. **Commit** `feat(backend): db-backed job queue and worker`

### Task 2: Сповіщення й диспетчер
**Files:** схеми `notifications`, `notification_prefs`; колонка `events.dispatched_at` (+індекс); `backend/src/notifications/{dispatcher,recipients,notifications.service,notifications.routes,prefs.routes}.ts`; `shared/src/contracts/notifications.ts`; tests.
**Interfaces:** Отримувачі визначаються з `entity_type/entity_id/payload` події — перевір кожен виклик `logEvent` (32 місця) і, де бракує даних (gameId, applicantId тощо), доповни `payload` у місці виклику. `notifications(id, event_id null, user_id, type, category, payload json, entity_type, entity_id, created_at, read_at null)` UNIQUE(event_id, user_id) (дедуплікація при повторній обробці події); `notification_prefs(user_id PK, telegram json {category: bool}, reminder_offsets json number[])`; диспетчер — задача кожні 10 с: бере пачку до 200 подій `WHERE dispatched_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED`, у тій самій транзакції створює сповіщення й ставить `dispatched_at` (події без отримувачів — теж позначаються), мапить `EVENT_TYPES` → отримувачі (`recipients.ts`: application.created → майстер; approved/rejected/cancelled_* → заявник; member.kicked/banned → учасник; member.left → майстер; session.* → майстер+активні учасники; game.converted/rule_changed/cancelled/finished → учасники), створює сповіщення, шле `notification.new` у `user:<id>`, ставить Telegram у outbox (Task 4). API: `GET /api/me/notifications?cursor&limit` (новіші першими), `GET /api/me/notifications/unread-count`, `POST /api/me/notifications/:id/read`, `POST /api/me/notifications/read-all`, `GET/PUT /api/me/notification-prefs`.
- [ ] Тести: кожен тип події дає сповіщення правильним отримувачам і нікому іншому; повторна обробка не дублює; подія без отримувачів позначається обробленою; дві паралельні обробки не дублюють; prefs валідуються (offsets лише з дозволеного набору). **Commit** `feat(backend): notifications from domain events`

### Task 3: Нагадування й щоденні задачі
**Files:** `backend/src/notifications/reminders.ts`, `backend/src/jobs/daily.ts`, `backend/src/realtime/socket.ts` (перевалідація), схема `reminder_log`; tests.
**Interfaces:** задача кожні 5 хв: для кожного офсету знаходить `scheduled` сесії з `starts_at - offset ∈ [now, now+5хв)` → сповіщення `session.reminder` майстру й активним учасникам з цим офсетом у prefs; `reminder_log` UNIQUE запобігає дублю; щоденні: `materializeAll`, `purgePendingUsers` (pending > 7 днів без заявок/ігор), `purgeReadNotifications` (> 90 днів); `revalidateSockets` кожні 5 хв (відключає сокети з недійсною сесією).
- [ ] Тести: **(Review Focus 2)** скасована сесія — 0 нагадувань; перенесена — за новим часом; повторний прогін не дублює; користувач з `[]` — нічого; purge не чіпає користувача з заявкою. **Commit** `feat(backend): session reminders and daily maintenance jobs`

### Task 4: Telegram-доставка
**Files:** схема `telegram_outbox`; `backend/src/internal/telegram-outbox.routes.ts`; `bot/src/delivery/{poller,render}.ts`, `bot/src/i18n/uk.json`; tests (backend + bot).
**Interfaces:** `telegram_outbox(id, notification_id UNIQUE, chat_id, kind, params json, buttons json null, status pending|sent|failed, attempts, next_try_at)`; ставиться диспетчером лише якщо в користувача є Telegram-ідентичність і категорія увімкнена; `GET /api/internal/telegram/outbox?limit=20` (видає й позначає `locked_until`), `POST /api/internal/telegram/outbox/:id/sent`, `.../failed {retryable}`; бот опитує кожні 3 с, рендерить `kind` + `params` через i18n (`notify.<type>`), кнопки — inline keyboard з `callback_data` ≤ 64 байт (`a:<appId>:ok|no`, `r:<sessionId>:y|n`); подяка `thanks.<genreSlug>` (11 жанрів, у RP-стилі, українською; запасний `thanks.default`).
- [ ] Тести: **(Review Focus 5)** без Telegram/з вимкненою категорією — немає outbox; рендер кожного типу з екрануванням; повтор після `failed retryable`; відповідь Telegram 403 (бот заблоковано) → `failed` без повторів. **Commit** `feat: telegram delivery of notifications`

### Task 5: Дії з бота й RSVP
**Files:** схема `session_rsvp`; `backend/src/internal/telegram-actions.routes.ts`, `backend/src/sessions/rsvp.ts` (+ `PUT /api/sessions/:id/rsvp`), `bot/src/delivery/callbacks.ts`; tests.
**Interfaces:** `POST /api/internal/telegram/action {telegramId, action: 'approve'|'reject'|'rsvp', id, value?}` → знаходить користувача за `auth_identities(provider='telegram', subject=telegramId)`, виконує ту саму сервісну функцію з тими самими правами, що й веб; відповідь → бот редагує повідомлення («✅ Затверджено» / помилка). RSVP: `going|not_going`, лише активні учасники, лише майбутні `scheduled` сесії; `SessionDto` отримує `rsvp` (мій) і для майстра — зведення.
- [ ] Тести: **(Review Focus 3)** чужий Telegram-id → 403, заявка не змінюється; невідомий id → 404; повторне натискання → ідемпотентно; RSVP колишнього учасника → 403. **Commit** `feat: telegram actions and session rsvp`

### Task 6: isViewed і пінги змін
**Files:** схема `entity_views`; `backend/src/views/views.service.ts`; доповнити DTO (`GameDto`, `GameCardDto` у «Мої ігри», заявки майстра, `MyApplicationDto`, `SessionDto`) полем `seen`; кімнати `game:<id>` у `realtime/socket.ts` (`join-game` з перевіркою: публічна гра — будь-хто автентифікований; приватні зміни (сесії, склад) — окремий `game-members:<id>` лише майстер+активні); пінги `game.changed {gameId, scope: 'details'|'sessions'|'members'|'applications'}` без інших даних з місць, де змінюються дані; tests.
- [ ] Тести: **(Review Focus 4)** колишній учасник не приєднується до `game-members:<id>`; пінг не містить нічого, крім id і scope; `seen` переходить new→seen після GET деталей і →updated після зміни. **Commit** `feat(backend): viewed state and change pings`

### Task 7: Фронтенд — центр сповіщень і налаштування
Дзвіночок у шапці з лічильником (aria-live), панель зі списком (довантаження), «прочитати все», перехід за посиланням сповіщення; сторінка `/settings/notifications` (Telegram-перемикачі за категоріями, офсети нагадувань чипами, заклик прив'язати Telegram, якщо не прив'язано). Тексти сповіщень — `notifications.<type>` з параметрами. Specs. **Commit** `feat(frontend): notification center and preferences`

### Task 8: Фронтенд — банер оновлень, «нове», RSVP
`ChangeWatcher` сервіс (підписки на кімнати сторінки), фіксований банер «Є оновлення — оновити» без зсуву; бейджі «Нове/Оновлено» за `seen`; RSVP-кнопки в списку сесій і зведення для майстра. Specs. **Commit** `feat(frontend): live update banner, new badges, rsvp`

### Task 9: Фінальна перевірка
Повний прогін, Docker-образи, ручна перевірка в браузері (сповіщення в реальному часі між двома користувачами, банер оновлення, RSVP). Telegram без токена бота перевіряється тестами рендеру. Оновити беклог. **Commit** `docs: plan 4 verification and backlog`
