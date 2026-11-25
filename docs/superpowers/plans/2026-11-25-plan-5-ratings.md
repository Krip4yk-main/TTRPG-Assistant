# НРІ Асистент — План 5: Відгуки й рейтинги

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Учасники ігор анонімно оцінюють одне одного (після сесій, після гри, при виході); рейтинги майстра й гравця публікуються пачками й видні в профілі, на картці та сторінці гри; пошук сортує за рейтингом майстра.

**Architecture:** Сирі оцінки — таблиця `ratings` (одна строка = оцінка або відмова). Права й вікна — один модуль `ratings.eligibility.ts`, що відповідає «кого я можу оцінити зараз». Після кожної оцінки в тій самій транзакції перевіряється, чи набралась пачка, і якщо так — перераховується й записується зріз у `published_ratings`; читання (профіль, картки, сортування) — лише з цієї таблиці. Запрошення оцінити — нові типи сповіщень із подій Плану 3/4 через диспетчер; нагадування «за 2 дні до закриття» — рекурентна задача планувальника з журналом.

**Tech Stack:** як у Плані 4 (Express 5, Drizzle/MySQL 8.4, Redis, Socket.IO, grammY, Angular 22). Нових залежностей немає.

**Spec:** `docs/superpowers/specs/2026-11-25-plan-5-ratings-design.md` (затверджено власником) + `docs/superpowers/specs/2026-11-24-nri-assistant-design.md` §5.

## Global Constraints

- Шкала 1–5 (цілі). Загальна оцінка обов'язкова (крім відмови); критерії — кожен за бажанням; текст ≤ 2000 символів (trim), бачить лише адміністрація (у цьому плані — ніде не віддається).
- Критерії майстра: `preparation`, `atmosphere`, `fairness`, `organization`, `safety`. Критерії гравця: `punctuality`, `engagement`, `teamplay`, `respect`.
- «Грали разом» = обидва на хоча б одній сесії гри зі статусом `done` (`session_attendance.present = true`; майстер гри вважається присутнім на всіх `done` сесіях).
- Вікна: сесійна — 14 днів від `game_sessions.done_at`; підсумкова — 30 днів від завершення гри (`games.finished_at`); «вихідна» (хтось із пари вийшов/виключений/забанений) — від моменту виходу до 30 днів після завершення **або скасування** гри. Скасована гра — підсумкової немає.
- Одна сесійна оцінка (або відмова) від оцінювача кожному на сесію; одна підсумкова на гру (поставлена при виході лишається чинною).
- Агрегація: одиниця = «оцінювач + гра» (середнє всіх його оцінок цієї людини в цій грі); рейтинг = середнє одиниць. Окремо для загальної й кожного критерію (пропущений критерій не входить). Відмови не входять ні в середні, ні в кількість.
- Публікація: перша — від 5 одиниць; далі — коли з'явилось ще ≥ 5 нових одиниць від останньої публікації. Критерій показується, лише якщо в зрізі по ньому ≥ 5 одиниць. Показана кількість — кількість одиниць.
- Роль/джерело: оцінка майстра гри → `gm`; оцінка учасника від майстра гри → `player_from_gm`; оцінка учасника від іншого учасника → `player_from_player`.
- Анонімність: жоден API не віддає окремі оцінки, оцінювачів чи час оцінок іншим людям; зміни видно лише пачками.
- Як у попередніх планах: компоненти .ts/.html/.less без inline-шаблонів; тексти — `uk.json` (фронт) і `bot/src/i18n/uk.json`; контракти — `@nri/shared`; права — на бекенді; час у БД — UTC; prettier лише на змінених файлах; `npm test`, `npm run typecheck`, `npm run lint`, `npm run build -w frontend` — зелені.

## Review Focus

1. **Накрутка однією людиною:** 10 сесійних оцінок від одного оцінювача в одній грі = одна одиниця; пачка з 5 оцінок від двох людей у двох іграх — не публікується. Тест — Task 3.
2. **Оцінка без спільної сесії:** гравець, що приєднався після виходу іншого, не може оцінити його (403), і навпаки; хто вийшов до першої сесії — нікого. Тест — Task 2.
3. **Вікна на межах:** сесія `done_at` 14 днів тому мінус хвилина — можна, плюс хвилина — 409; «вихідна» оцінка під час кампанії — можна, через 30 днів після скасування — ні. Тест — Task 2.
4. **Подвійне надсилання / гонка:** два паралельні POST тієї самої оцінки → одна строка, другий 409; паралельні оцінки різних людей не губляться при перерахунку пачки. Тест — Task 2/3.
5. **Витік через відповіді:** профіль/картка не містять полів окремих оцінок; рейтинг до 5 одиниць — `null`, а не «4.7 (2)». Тест — Task 3.

---

### Task 1: Схема й контракти

**Files:** Create `backend/src/db/schema/ratings.ts` (+ export в `schema/index.ts`), міграція `0019_plan5_ratings.sql` через `drizzle-kit generate`; Create `shared/src/contracts/ratings.ts` (+ export у `shared/src/index.ts`); Modify `backend/test/helpers.ts` (TABLES); Test `shared/src/contracts/ratings.test.ts`.

**Interfaces — Produces:**
- `ratings(id, rater_id FK users cascade, ratee_id FK users cascade, game_id FK games cascade, session_id FK game_sessions cascade NULL, kind enum('session','final'), role enum('gm','player_from_gm','player_from_player'), declined bool, overall tinyint NULL, criteria json NULL /* {key: 1..5} */, comment varchar(2000) NULL, created_at datetime(3))`; UNIQUE `(rater_id, ratee_id, game_id, slot_key)` де `slot_key` — згенерована колонка `COALESCE(session_id, 0)`; індекси `(ratee_id, role, id)`, `(game_id)`.
- `published_ratings(user_id FK cascade, role enum(...), overall decimal(3,2), overall_units int, criteria json /* {key: {avg, units}} */, units int, last_rating_id bigint, published_at datetime(3), PK(user_id, role))`.
- `rating_reminder_log(user_id, game_id, session_id NULL, slot_key generated COALESCE(session_id,0), kind enum('deadline'), sent_at, UNIQUE(user_id, game_id, slot_key, kind))`.
- shared: `RATING_ROLES`, `GM_CRITERIA = ['preparation','atmosphere','fairness','organization','safety']`, `PLAYER_CRITERIA = ['punctuality','engagement','teamplay','respect']`, `RATING_MIN_UNITS = 5`, `RATING_BATCH_UNITS = 5`, `SESSION_RATING_WINDOW_DAYS = 14`, `FINAL_RATING_WINDOW_DAYS = 30`, `RATING_COMMENT_MAX = 2000`; `ratingInputSchema` (strict: `{rateeId: string /*publicId*/, sessionId?: number, declined?: true} | {rateeId, sessionId?, overall: 1..5, criteria?: Partial<Record<criterion,1..5>>, comment?: string}` — критерії перевіряються на бекенді за роллю); `RatingTargetDto {publicId, nickname, avatarUrl, role: RatingRole, state: 'open'|'rated'|'declined', closesAt: string}`; `RatingTargetsDto {gameId, sessionId: number|null, kind, targets: RatingTargetDto[]}`; `PublishedRatingDto {overall: number, units: number, criteria: Record<string, number>}` (лише критерії з ≥5 одиниць); `UserRatingsDto {gm: PublishedRatingDto|null, playerFromGm: …|null, playerFromPlayer: …|null}`.

- [ ] Тести shared: схема відкидає `overall: 0/6/2.5`, коментар 2001 символ, невідомі ключі; приймає відмову без `overall`. Міграція застосовується (`npm run db:migrate -w backend`), `resetDb` чистить нові таблиці. **Commit** `feat: ratings schema and contracts`

### Task 2: Права, вікна й API оцінювання

**Files:** Create `backend/src/ratings/{ratings.eligibility.ts, ratings.service.ts, ratings.routes.ts}`; mount `/api/games/:id/ratings` і `/api/me/ratings` в `app.ts`; Test `backend/test/ratings/eligibility.test.ts`, `backend/test/ratings/ratings.api.test.ts`.

**Interfaces:**
- Consumes: Task 1 таблиці/схеми; `isHiddenFromNonGm` (`games.visibility.ts`); `game_members` (`left_at`, `left_reason`), `session_attendance`, `games.finished_at`, статуси гри; `isDuplicateKey` (`db/errors.ts`).
- Produces:
  - `playedTogether(db, gameId, a: number, b: number): Promise<boolean>`.
  - `ratingTargets(deps, raterId, gameId, sessionId: number | null, now?): Promise<RatingTargetsDto>` — для `sessionId` — присутні на тій сесії (крім себе) у вікні 14 днів; для `null` — підсумкові/«вихідні» цілі: усі, з ким `playedTogether`, якщо гра `finished` (вікно 30 днів) або хтось із пари вийшов (до 30 днів після finished/cancelled; поки гра йде — відкрито).
  - `submitRating(deps, raterId, gameId, input: RatingInput, now?): Promise<RatingTargetDto>` — у транзакції: lock game FOR SHARE → перевірка цілі через ту саму логіку, що й `ratingTargets` → INSERT (дубль → 409 `RATING_EXISTS`) → `maybePublish(tx, rateeId, role)` (Task 3; у цій задачі — no-op заглушка з тим самим підписом) → після коміту `logEvent('rating.created', {gameId})` без оцінювача.
  - Роути: `GET /api/games/:id/ratings/targets?sessionId=` → `RatingTargetsDto`; `POST /api/games/:id/ratings` (body `ratingInputSchema`) → 201 `RatingTargetDto`; `GET /api/me/ratings/pending` → `RatingTargetsDto[]` (усі відкриті набори для мене, для сторінки «Оцінити»). Auth + requireActive + CSRF.
  - Нові коди помилок у `ERROR_CODES` + `uk.json errors.*`: `RATING_EXISTS` (409), `RATING_NOT_ALLOWED` (403 — не грали разом / себе / не учасник), `RATING_WINDOW_CLOSED` (409), `RATING_CRITERIA_INVALID` (400 — критерій не з набору ролі).
- [ ] Тести: (**Review Focus 2**) A приєднався після виходу B → 403 в обидва боки; вийшов до першої сесії → цілей немає; майстер може оцінити присутнього учасника сесії, відсутнього — ні; (**Review Focus 3**) межі 14/30 днів (±1 хв), «вихідна» поки кампанія йде — відкрито, через 30 днів після cancelled — 409; скасована гра — підсумкової немає; (**Review Focus 4**) два паралельні POST → 201 + 409, одна строка; відмова → state `declined`, повторно оцінити → 409; критерій гравця в оцінці майстра → 400; прихована гра → 404; повернувся після виходу — повторна підсумкова → 409. **Commit** `feat(backend): rating eligibility, windows and submission`

### Task 3: Агрегація, пачки й відображення

**Files:** Create `backend/src/ratings/ratings.aggregate.ts`; Modify `ratings.service.ts` (`maybePublish`), профіль (`profiles.service.ts` + `PublicProfileDto.ratings: UserRatingsDto`), картки й деталі гри (`GameCardDto.gmRating`, `GameDto.gmRating`, `RestrictedGameDto` — без рейтингу), пошук (`games.search.ts`: `SEARCH_SORTS` + `'gm_rating'`); Test `backend/test/ratings/aggregate.test.ts`, `backend/test/games/search.test.ts`, `backend/test/profiles/*.test.ts`.

**Interfaces:**
- Produces: `computeRating(rows: {raterId, gameId, overall, criteria}[]): {overall, overallUnits, criteria: Record<k,{avg, units}>, units}` (чиста функція: одиниця = (raterId, gameId); відмови відфільтровані до виклику); `maybePublish(tx, userId, role): Promise<boolean>` — рахує поточні одиниці (за не-відмовами), порівнює з `published_ratings.units` (0, якщо немає): публікує, якщо `units ≥ 5` і (`немає зрізу` або `units − published.units ≥ 5`); запис зрізу UPSERT, `SELECT … FOR UPDATE` рядка зрізу (або вставка-заготовка) для серіалізації паралельних оцінок; після коміту `logEvent('rating.published', {userId, role})` без даних оцінок. `gmRating: number | null` (1 знак після коми, лише якщо `units ≥ 5`). Сортування `gm_rating`: за `published_ratings.overall` спадно, без рейтингу — після; кампанії, що вже йдуть, — внизу (як у `soonest`); стабільний курсор (rating, id).
- Округлення: значення в БД — 2 знаки; у DTO — 1 знак (`Math.round(x*10)/10`).
- [ ] Тести: (**Review Focus 1**) 10 оцінок від одного оцінювача в одній грі = 1 одиниця; той самий оцінювач у двох іграх = 2 одиниці; 4 одиниці → `null`, 5 → опубліковано, 9 → без змін, 10 → нова публікація; критерій з 4 одиницями не показується, загальна з 5 — так; відмови не рахуються; паралельні 5-ті й 6-ті оцінки не губляться (зріз = 6 після наступної пачки); (**Review Focus 5**) профіль/картка не містять `raterId`/`comment`/часу; сортування `gm_rating` з курсором (без рейтингу — після; запущені кампанії — внизу). **Commit** `feat(backend): published ratings in batches, profile and search`

### Task 4: Запрошення й нагадування оцінити

**Files:** Modify `shared/src/contracts/notifications.ts` (категорія `ratings`; типи `rating.session_open`, `rating.final_open`, `rating.member_left`, `rating.deadline`; `NotificationParams.closesAt?`, `ratee?` {publicId,nickname}; `notificationLink` → `/games/:id/rate` або `/games/:id/rate?session=:sid`), `backend/src/notifications/recipients.ts` (події `session.done` → присутні на сесії, яким є кого оцінити; `game.finished` → усі, у кого відкриті підсумкові/«вихідні» цілі; `member.left|kicked|banned` → той, хто вийшов (якщо є кого оцінити) і всі, хто грав із ним разом (`rating.member_left` з `ratee`)), Create `backend/src/ratings/ratings.reminders.ts` (рекурентна задача `ratings.deadline` щогодини: оцінювачам, у яких вікно закривається через ≤ 48 год і є `open` цілі в цьому наборі — `rating.deadline`, дедуп `rating_reminder_log`; для «вихідних» оцінок, поки гра йде, дедлайну немає — нагадування лише після finished/cancelled), bot `uk.json` (`notify.rating.*`), frontend `uk.json` (`notifications.rating.*`, категорія в налаштуваннях); Test `backend/test/ratings/reminders.test.ts`, розширити `dispatcher.test.ts`, bot render test.

**Interfaces:** Consumes `ratingTargets` (Task 2) для рішення «чи є кого оцінити»; `createNotification`/`emitNotificationsNew` (План 4); registerHandler/registerRecurring (`jobs/index.ts`); вікно рахується від `job.runAt`.
- [ ] Тести: `session.done` → сповіщення лише присутнім (не відсутнім, не тим, хто вже оцінив усіх); вихід → сповіщення всім, хто грав разом із тим, хто вийшов, і йому самому; хто не грав разом — нічого; `game.finished` → включає тих, хто вийшов, якщо вони ще не оцінили; дедлайн: за 48 год — одне нагадування, повторний прогін — без дублів, відмова/оцінка всіх — без нагадування; категорія `ratings` вимкнена для Telegram → немає рядка outbox; рендер усіх `rating.*` у боті. **Commit** `feat: rating invitations and deadline reminders`

### Task 5: Фронтенд — форма оцінювання й відображення

**Files:** Create `frontend/src/app/core/ratings/ratings.api.ts`, `features/ratings/rate-page/*` (маршрут `/games/:id/rate`, `?session=`), `features/ratings/rating-summary/*` (компонент показу `PublishedRatingDto`), сторінка «Оцінити» `/ratings` (список `GET /api/me/ratings/pending`); Modify профіль (`features/profile/profile-page`), картка гри й сторінка гри (рейтинг майстра), пошук (опція сортування «За рейтингом майстра»), список сесій (кнопка «Оцінити» для `done` сесій у вікні), шапка/меню (посилання «Оцінити» з лічильником, якщо є відкриті), `uk.json`; specs.

- Форма: для кожної цілі — загальна оцінка 1–5 (обов'язкова; доступна radiogroup з зірками, клавіатура ←/→), критерії за роллю цілі (необов'язкові, з кнопкою «скинути»), текст (≤ 2000, лічильник, пояснення «бачить лише адміністрація»), кнопки «Надіслати» і «Відмовитись» (з підтвердженням «оцінити пізніше вже не вийде»); попередження «після надсилання змінити не можна»; показ `closesAt`; після відправки ціль показує «Оцінено»/«Відмовлено». Помилки — `errors.<code>`.
- Відображення: `null` → «Ще немає рейтингу (потрібно 5 оцінок)»; інакше «4.6 · 12 оцінок» + критерії з назвами; у профілі гравця — два блоки «від майстрів» / «від гравців».
- [ ] Specs: форма (обов'язкова загальна, критерії за роллю, відмова з підтвердженням, 409 показує стан, вікно закрите), сторінка «Оцінити», показ рейтингу (null/значення/критерії), сортування в пошуку передає `sort=gm_rating`, a11y зірок (role radiogroup, aria-checked, клавіатура). **Commit** `feat(frontend): rating form, pending ratings, rating display`

### Task 6: Фінальна перевірка

- [ ] `npm test && npm run typecheck && npm run lint && npm run build -w frontend`; `docker build` трьох образів.
- [ ] Ручна перевірка в браузері (dev-логін, кілька користувачів): майстер проводить сесію з присутністю → гравці бачать «Оцінити» → оцінюють; 5 різних пар «людина + гра» → рейтинг з'являється в профілі й на картці; сортування за рейтингом майстра; вихід гравця → сповіщення іншим; відмова.
- [ ] Оновити `docs/superpowers/backlog.md`. **Commit** `docs: plan 5 verification and backlog`
