# НРІ Асистент — План 3: Заявки, учасники, сесії, нотатки, календар

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Гравець подає заявку на гру з погодженням попереджень, відповідями на анкету й власними обмеженнями; майстер розглядає заявки, керує учасниками (виключення, бан у грі, чорний список), веде сесії кампанії (перенесення, скасування, завершення з присутністю); учасники ведуть нотатки; почалі ігри автоматично займають час у календарі.

**Architecture:** Продовження модулів Плану 2. Нові бекенд-модулі `applications/`, `members/`, `sessions/`, `notes/`, `appeals/` за шаблоном routes + service + zod-контракти в `@nri/shared`. Правила доступу до гри для учасника — розширення `games.visibility.ts` (єдине місце). Доменні події пишуться в `events` (`logEvent`) з фіксованими типами — План 4 перетворить їх на сповіщення. Сесії — матеріалізовані записи на 4 тижні вперед.

**Tech Stack:** як у Плані 2. Нових залежностей немає.

**Spec:** `docs/superpowers/specs/2026-11-24-nri-assistant-design.md` (§3, §4, §6) + `docs/superpowers/backlog.md` (розділ «План 3»).

## Рішення власника для Плану 3 (2026-11-24)

- **Заявки:** на одну гру в гравця — лише одна **активна** заявка (`pending`); після відхилення/відкликання можна подати знову без затримки. Обмежує майстер — баном у грі або чорним списком.
- Склад заявки: погодження з попередженнями (обов'язкове), відповіді на анкету майстра (обов'язкові, якщо є питання), повідомлення майстру (≤ 1000), власні обмеження (≤ 10 пунктів по ≤ 200).
- Майстер відповідає на **кожне** обмеження: `accepted` / `partial` (коментар) / `cannot_guarantee`; до й після затвердження.
- Подаватись можна в `recruiting` і в `started` з `show_when_full`; майстер може затвердити понад максимум; вік перевіряє сервер.
- **Вікова позначка:** якщо майстер у `recruiting` піднімає позначку (до 18+/21+), усі `pending`-заявки акаунтів, молодших за нову позначку, автоматично скасовуються (подія для гравця й майстра). Підняти позначку, коли серед **учасників** є молодший за неї, — заборонено (409), доки такі учасники не вийдуть.
- **Вихід із гри:** поле «для майстра» обов'язкове (≥ 10 символів), «для адміністрації» необов'язкове — якщо порожнє, заповнюється текстом «для майстра».
- Дії майстра з учасником: «Виключити» (може подати заявку знову), «Забанити в цій грі», «Додати в мій чорний список» (блокує заявки на всі ігри майстра); сторінка чорного списку з можливістю розбанити.
- Сторінка гри для учасників: адреса, канали, список сесій, склад гравців (ніки → профілі), відповіді майстра на мої обмеження.
- **Сесії:** матеріалізовані на **4 тижні** вперед від правила розкладу; вікно зсувається при старті, завершенні сесії й перегляді. Окрему сесію можна перенести/скасувати; окрема дія — змінити правило для майбутніх сесій. «Завершити сесію» — присутність + підсумок/нотатки (бачать лише учасники).
- Ваншот: «Завершити гру» завершує й його єдину сесію. Кнопка **«Перетворити на кампанію»** (у `recruiting`/`started`): `kind→campaign` + нове правило регулярності.
- Правила з рецензії Плану 2: `maxPlayers` не менше поточної кількості учасників; старт з меншою за мінімум кількістю — дозволено з попередженням.
- Сповіщення, реальний час і бот — План 4; у Плані 3 — статуси на сторінках і події в `events`.
- **Системний бан:** при спробі входу забанений користувач бачить повідомлення про бан і може надіслати адміністрації **одне** повідомлення (апеляцію); перегляд — План 5 (адмінка).
- **Календар:** сесії почалих ігор автоматично займають час у календарі майстра й учасників (за замовчуванням увімкнено; вимикається в налаштуваннях; якщо вимкнено — кнопка «Додати в мій календар» на сторінці гри). Зайнятість оновлюється при перенесенні/скасуванні сесії, скасуванні/завершенні гри, виході учасника. Показується в часовому поясі користувача й візуально відрізняється від заданого вручну.
- **Нотатки** (для будь-якої гри — і кампанії, і ваншоту):
  1. Спільна нотатка гравців на гру (не видима майстру): у кожного гравця своя «сторінка», читати можуть усі гравці, редагувати — лише свою. Сторінка колишнього учасника лишається видимою з позначкою.
  2. Приватна нотатка на гру для кожного учасника, включно з майстром.
  3. Приватна нотатка на кожну сесію для кожного учасника, включно з майстром.
  Простий текст з переносами рядків, ≤ 20 000 символів, автозбереження.

## Рішення розробника (перевір)

- Автозайнятість у календарі не зберігається окремими рядками: вона **обчислюється** з `game_sessions` ігор, де користувач — майстер або учасник (`status in recruiting|started`, сесії `scheduled`), з урахуванням налаштування. Для «ручного» режиму зберігається множина ігор, які користувач додав (`calendar_pinned_games`). Так зайнятість завжди актуальна без синхронізації.
- Пошук ігор (`availabilityFit`) враховує цю зайнятість як зайнятий час (гра не «підходить», якщо перетинається з уже прийнятою грою гравця).
- Нотатки — оптимістична конкуренція через `version` (PUT з `version`, при розбіжності 409 `NOTE_CONFLICT` з актуальним текстом).
- Сесія ваншота створюється при публікації (як і для кампанії — з правила, яке для ваншота дає одну сесію).
- Апеляція — одна на період бану (повторна після розбану й нового бану дозволена).

## Global Constraints

- Кожен Angular-компонент — окремі `*.ts`, `*.html`, `*.less`; без `template:`/`styles:` у `.ts`.
- Весь текст UI — ключі `uk.json`; помилки API — коди з `ERROR_CODES`, кожен новий код має переклад `errors.<CODE>`.
- Контрактні типи — лише в `@nri/shared`.
- Бізнес-правила й права доступу — на бекенді; правила видимості гри — лише в `games.visibility.ts`.
- Час у БД — UTC; відображення — у поясі глядача з позначкою поясу гри, якщо відрізняється.
- Події для Плану 4 — через `logEvent` з типами з `shared/src/contracts/events.ts` (`EVENT_TYPES`).
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build -w frontend` — зелені перед кожним комітом. Форматувати лише змінені файли.

## Review Focus

1. **Гонка двох заявок/затверджень:** два одночасні POST заявки одного гравця на одну гру → рівно одна `pending` (унікальний індекс на активну заявку); два одночасні затвердження однієї заявки → один учасник. Тест — Task 2.
2. **Неповнолітній і 18+:** 17-річний не може подати заявку на 18+ (403); підняття позначки скасовує його `pending`-заявку; з 17-річним учасником підняти позначку → 409. Тест — Task 2, Task 3.
3. **Доступ до приватного:** колишній учасник, виключений, забанений, сторонній — не бачать адреси, каналів, сесійних нотаток і спільної нотатки гравців; майстер не бачить спільну нотатку гравців і приватні нотатки інших. Тест — Task 3, Task 6.
4. **Сесії через DST і зміну правила:** зміна правила регулярності не чіпає вже перенесені/завершені сесії й не дублює майбутні. Тест — Task 4.
5. **Конфлікт нотатки:** дві вкладки одного користувача пишуть нотатку → друга отримує 409 з актуальним текстом, нічого не губиться мовчки. Тест — Task 6.

---

## File Structure

```
shared/src/contracts/
  applications.ts   members.ts   sessions.ts   notes.ts   events.ts   appeals.ts
backend/src/db/schema/
  applications.ts  members.ts (розширення game_members, game_bans, gm_blacklist)
  sessions.ts (game_sessions, session_attendance)  notes.ts  calendar.ts  appeals.ts
backend/src/
  applications/applications.{routes,service}.ts
  members/members.{routes,service}.ts   members/blacklist.routes.ts
  sessions/sessions.{routes,service}.ts   sessions/materialize.ts
  notes/notes.{routes,service}.ts
  calendar/game-busy.service.ts
  appeals/appeals.{routes,service}.ts
frontend/src/app/features/
  applications/{apply-dialog,my-applications,game-applications}/…
  members/{members-panel,leave-dialog,blacklist-page}/…
  sessions/{sessions-list,session-actions,finish-session-dialog,convert-to-campaign-dialog}/…
  notes/{note-editor,shared-player-notes}/…
  auth/banned-notice/…
```

---

### Task 1: Контракти й схема БД

**Files:** Create `shared/src/contracts/{applications,members,sessions,notes,events,appeals}.ts` (+ експорт), `backend/src/db/schema/{applications,sessions,notes,calendar,appeals}.ts`, Modify `backend/src/db/schema/games.ts` (`game_members`), migration `0008_plan3.sql`, `backend/test/helpers.ts` (TABLES). Test: `backend/test/db/plan3-schema.test.ts`, `shared/src/contracts/*.test.ts`.

**Interfaces:**
- `game_applications(id, game_id FK, user_id FK, status enum('pending','approved','rejected','withdrawn','cancelled'), message text null, answers json string[], constraints json {id:string,text:string}[], warnings_accepted_at datetime, cancel_reason enum('age_rating','game_cancelled','banned') null, created_at, decided_at null, decided_by null)`; унікальність активної заявки: згенерована колонка `active_key = IF(status='pending', CONCAT(game_id,':',user_id), NULL)` + UNIQUE.
- `application_constraint_responses(application_id FK, constraint_id varchar(16), response enum('accepted','partial','cannot_guarantee'), comment varchar(500) null, updated_at)` PK(application_id, constraint_id).
- `game_members` + `role enum('player') default 'player'`, `application_id null`, `left_at datetime null`, `left_reason enum('left','kicked','banned') null`, `leave_note_gm text null`, `leave_note_admin text null`; активний учасник = `left_at IS NULL`. PK стає `id` + UNIQUE `(game_id,user_id,active)` за тим самим прийомом згенерованої колонки.
- `game_bans(game_id, user_id, created_at)` PK; `gm_blacklist(gm_user_id, user_id, created_at)` PK.
- `game_sessions(id, game_id FK, starts_at, duration_minutes, status enum('scheduled','done','cancelled'), origin enum('rule','manual'), rule_starts_at datetime null /* слот правила, з якого згенеровано */, rescheduled bool default false, cancel_reason varchar(300) null, summary text null, done_at null)`; UNIQUE `(game_id, rule_starts_at)`.
- `session_attendance(session_id, user_id, present bool)` PK.
- `notes(id, scope enum('game_shared','game_private','session_private'), game_id, session_id null, user_id, body mediumtext, version int, updated_at)` UNIQUE `(scope, game_id, session_id_or_0, user_id)`.
- `user_settings(user_id PK, calendar_autobusy bool default true)`; `calendar_pinned_games(user_id, game_id)` PK.
- `ban_appeals(id, user_id, message text ≤ 2000, created_at, ban_epoch int)` UNIQUE(user_id, ban_epoch); `users` + `ban_epoch int default 0` (збільшується при кожному бані).
- `EVENT_TYPES` (shared): `application.created|approved|rejected|withdrawn|cancelled_age|cancelled_game`, `member.left|kicked|banned`, `gm.blacklisted|unblacklisted`, `session.rescheduled|cancelled|done`, `game.converted_to_campaign`, `game.rule_changed`, `appeal.created`.
- Нові коди помилок: `APPLICATION_EXISTS`, `APPLICATION_CLOSED`, `BANNED_FROM_GAME`, `GM_BLACKLISTED`, `WARNINGS_NOT_ACCEPTED`, `ANSWERS_REQUIRED`, `AGE_RATING_HAS_MINORS`, `MAX_BELOW_MEMBERS`, `NOT_A_MEMBER`, `SESSION_INVALID_STATE`, `NOTE_CONFLICT`, `APPEAL_EXISTS`, `AGE_RESTRICTED_APPLY` — з перекладами.

- [ ] **Step 1:** Тести: друга `pending`-заявка того ж гравця на ту ж гру → дубль ключа; після `rejected` нова `pending` — успішно; два активні членства одного користувача в одній грі → дубль; `left_at` встановлено → можна знову активне. **Step 2:** FAIL. **Step 3:** Схема + міграція (+ `npm run db:migrate -w backend`). **Step 4:** PASS. **Commit** `feat: plan 3 schema and contracts`

---

### Task 2: Заявки (бекенд)

**Files:** Create `backend/src/applications/applications.{routes,service}.ts`; Modify `backend/src/games/games.service.ts` (підняття вікової позначки), `app.ts`. Test: `backend/test/applications/applications.test.ts`.

**Interfaces:**
- `POST /api/games/:id/applications` (requireActive) `{ warningsAccepted: true, answers: string[], message?, constraints?: string[] }` → `ApplicationDto`; перевірки по черзі: гра видима й приймає заявки (`recruiting` або `started`+`show_when_full`) інакше 409 `APPLICATION_CLOSED`; заявник ≠ майстер (403 `FORBIDDEN`); вік заявника не відповідає `ageRating` (через `viewerAge` + `meetsAgeRating`) → 403 `AGE_RESTRICTED_APPLY`; бан у грі → 403 `BANNED_FROM_GAME`; чорний список майстра → 403 `GM_BLACKLISTED`; уже учасник → 409 `APPLICATION_EXISTS`; `warningsAccepted !== true` (якщо в гри є попередження) → 400 `WARNINGS_NOT_ACCEPTED`; кількість відповідей ≠ кількості питань або порожні → 400 `ANSWERS_REQUIRED`; дубль активної → 409 `APPLICATION_EXISTS`. Обмеженням присвоюються короткі `id` (nanoid 8).
- `DELETE /api/applications/:id` (власник, лише `pending`) → `withdrawn`.
- `GET /api/me/applications` — мої заявки з карткою гри (через `toCardView`) і відповідями майстра на обмеження.
- `GET /api/games/:id/applications` (лише майстер) — усі заявки з публічними профілями заявників (нік, аватар, publicId, вік **не** показується, лише ознака `meetsAgeRating`).
- `POST /api/applications/:id/approve` (майстер; лише `pending`) → створює активний `game_members` (транзакція, `FOR UPDATE` на заявці); `POST /api/applications/:id/reject`.
- `PUT /api/applications/:id/constraints/:constraintId` (майстер) `{response, comment?}` (`partial` вимагає коментар).
- Підняття вікової позначки в `updateGame` (статус `recruiting`/`started`): якщо є активний учасник, молодший за нову позначку → 409 `AGE_RATING_HAS_MINORS`; інакше всі `pending`-заявки молодших → `cancelled` з `cancel_reason='age_rating'` + подія `application.cancelled_age` (по одній на заявку). Скасування гри → `pending`-заявки `cancelled` (`game_cancelled`).
- Події: `application.created/approved/rejected/withdrawn`.

- [ ] **Step 1: Failing tests:** успішна заявка; майстер на свою гру → 403; 17-річний на 18+ → 403; бан у грі → 403 `BANNED_FROM_GAME`; чорний список → 403 `GM_BLACKLISTED`; **(Review Focus 1)** `Promise.all` двох POST → рівно один 201, один 409; два паралельні approve → один учасник; затвердження понад `max_players` дозволено; відкликання не-своєї → 404; після `rejected` повторна заявка → 201; **(Review Focus 2)** підняття позначки до 18+ скасовує pending 17-річного (статус `cancelled`, причина `age_rating`, подія), а з 17-річним учасником → 409 `AGE_RATING_HAS_MINORS`; `partial` без коментаря → 400.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізувати. **Step 4:** PASS. **Commit** `feat(backend): game applications with constraints and age rules`

---

### Task 3: Учасники, вихід, бани, чорний список, доступ учасника (бекенд)

**Files:** Create `backend/src/members/members.{routes,service}.ts`, `backend/src/members/blacklist.routes.ts`; Modify `games.visibility.ts` (активний учасник = `left_at IS NULL`), `games.service.ts` (`maxPlayers` ≥ учасників; старт < мін — `warning` у відповіді), `profiles` (`gamesAsPlayer` = опубліковані ігри, де користувач має будь-яке членство — активне чи завершене виходом/виключенням/баном). Test: `backend/test/members/members.test.ts`, `backend/test/games/visibility.test.ts` (доповнити).

**Interfaces:**
- `GET /api/games/:id/members` (майстер і активні учасники) → `{ publicId, nickname, avatarUrl, joinedAt }[]`.
- `POST /api/games/:id/leave` (учасник) `{ noteForGm: string ≥ 10, noteForAdmin?: string }` → `left_at`, `left_reason='left'`, `leave_note_admin = noteForAdmin || noteForGm`; подія `member.left`.
- `POST /api/games/:id/members/:publicId/kick` (майстер) → `left_reason='kicked'`; `.../ban` → `left_reason='banned'` + `game_bans`; `pending`-заявка забаненого → `cancelled('banned')`.
- `GET/POST/DELETE /api/me/blacklist[/:publicId]` (майстер) — список з профілями; додавання не виключає з поточних ігор (лише блокує нові заявки) — **виключення окремою дією**.
- `PATCH /api/games/:id` з `maxPlayers` < активних учасників → 409 `MAX_BELOW_MEMBERS`.
- `POST /api/games/:id/start` при учасниках < `min_players` → 200 з `{ warning: 'BELOW_MIN_PLAYERS' }`.
- Видимість: адреса/канали/сесії/склад — майстру й **активним** учасникам; колишній учасник — як сторонній.

- [ ] **Step 1: Failing tests:** вихід без `noteForGm` → 400; `noteForAdmin` порожнє → дорівнює `noteForGm`; виключений може подати заявку знову, забанений — ні; чорний список блокує заявку на іншу гру того ж майстра; **(Review Focus 3)** колишній/виключений/забанений не бачать адреси й каналів, активний — бачить; `maxPlayers` нижче учасників → 409; старт з 1 учасником при `min=3` → 200 + warning.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізувати. **Step 4:** PASS. **Commit** `feat(backend): members, leaving, game bans and gm blacklist`

---

### Task 4: Сесії (бекенд)

**Files:** Create `backend/src/sessions/{materialize,sessions.service,sessions.routes}.ts`; Modify `games.service.ts` (публікація/старт/зміна правила/перетворення на кампанію/завершення ваншота). Test: `backend/test/sessions/sessions.test.ts`, `backend/test/sessions/materialize.test.ts`.

**Interfaces:**
- `SESSION_WINDOW_DAYS = 28`. `materializeSessions(deps, gameId, now)`: для `recruiting|started` створює відсутні `origin='rule'` сесії з `expandOccurrences(game, now−1 день, now+28 днів)` (ідемпотентно за `UNIQUE(game_id, rule_starts_at)`); не чіпає `rescheduled`, `done`, `cancelled`. Викликається при публікації, старті, завершенні сесії, `GET` сесій.
- `GET /api/games/:id/sessions` (майстер + активні учасники) → `SessionDto[]` (минулі 30 днів + майбутні у вікні).
- `POST /api/sessions/:id/reschedule` (майстер) `{startsAt, durationMinutes?}` → `rescheduled=true`; `.../cancel` `{reason}`; `.../finish` `{attendance: {publicId, present}[], summary?}` → `done`.
- `PUT /api/games/:id/schedule` (майстер; `campaign`) `{recurrence, weekdays, startsAt, durationMinutes}` — нове правило: видаляє майбутні `scheduled` + `origin='rule'` + не `rescheduled` сесії й матеріалізує заново; подія `game.rule_changed`.
- Ваншот: `POST /api/games/:id/finish` позначає його сесію `done`. `POST /api/games/:id/convert-to-campaign` (майстер; `oneshot` у `recruiting|started`) `{recurrence, weekdays, …}` → `kind='campaign'` (обхід блокування поля лише в цій дії), подія.
- Подія для кожного переносу/скасування/завершення.

- [ ] **Step 1: Failing tests:** публікація щотижневої гри створює ~4 сесії; повторна матеріалізація не дублює; перенесена сесія не повертається на місце після матеріалізації; **(Review Focus 4)** зміна правила з Вт на Чт видаляє майбутні Вт (неперенесені), лишає перенесені й завершені, створює Чт; DST: сесії о 19:00 Kyiv до й після 2027-03-28; учасник не може переносити (403); завершення з присутністю записує `session_attendance`; ваншот → «перетворити на кампанію» дозволено, кампанія → 409.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізувати. **Step 4:** PASS. **Commit** `feat(backend): materialized sessions with reschedule, cancel, finish and rule changes`

---

### Task 5: Календар — автозайнятість від ігор (бекенд)

**Files:** Create `backend/src/calendar/game-busy.service.ts`; Modify `availability` (налаштування), `games.search.ts` (врахування зайнятості), `shared/src/contracts/availability.ts`. Test: `backend/test/calendar/game-busy.test.ts`, доповнити `search.test.ts`.

**Interfaces:**
- `GET/PATCH /api/me/settings` → `{ calendarAutoBusy: boolean }`.
- `POST/DELETE /api/me/calendar/pinned-games/:gameId` (лише для учасника/майстра гри) — ручний режим.
- `GET /api/me/calendar/game-busy?from&to` → `{ gameId, gameTitle, sessionId, start, end }[]` — сесії `scheduled` ігор `recruiting|started`, де користувач майстер або активний учасник; якщо `calendarAutoBusy=false` — лише закріплені ігри.
- `availabilityFit` у пошуку (режими `mine`/`custom` для залогіненого): сесії-кандидати, що перетинаються з `game-busy` користувача, вважаються такими, що не підходять. Розширити `availabilityFit` у shared опційним параметром `busyIntervals: {start: Date; end: Date}[]`.

- [ ] **Step 1: Failing tests:** зайнятість з'являється після затвердження заявки, зникає після виходу/виключення/скасування гри/скасування сесії, переноситься разом із сесією; вимкнений автомат → порожньо, після закріплення гри → є; пошук: гра, що перетинається з уже прийнятою, отримує `none`; shared-тест для `busyIntervals`.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізувати. **Step 4:** PASS. **Commit** `feat(backend): calendar busy time from joined games`

---

### Task 6: Нотатки (бекенд)

**Files:** Create `backend/src/notes/notes.{routes,service}.ts`. Test: `backend/test/notes/notes.test.ts`.

**Interfaces:**
- `GET /api/games/:id/notes/shared` (лише активні учасники-**гравці**, не майстер) → `{ pages: { author: {publicId,nickname,avatarUrl}, formerMember: boolean, body, version, updatedAt }[] }`; `PUT /api/games/:id/notes/shared` `{body, version}` — лише своя сторінка.
- `GET/PUT /api/games/:id/notes/private` (майстер і активні учасники) — своя нотатка.
- `GET/PUT /api/sessions/:id/notes/private` (майстер і активні учасники гри сесії).
- `PUT` з `version` ≠ поточній → 409 `NOTE_CONFLICT` з `details: { body, version }`; перший запис — `version: 0`. `body` ≤ 20 000.
- Колишній учасник втрачає доступ (403/404), його сторінка в спільній нотатці лишається з `formerMember: true`.

- [ ] **Step 1: Failing tests:** **(Review Focus 3)** майстер отримує 403 на спільну нотатку гравців і не бачить чужих приватних; гравець не може редагувати чужу сторінку; колишній учасник — 403, його сторінка видна іншим з позначкою; **(Review Focus 5)** два PUT з однаковою `version` → один 200, другий 409 з актуальним текстом; 20 001 символ → 400.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізувати. **Step 4:** PASS. **Commit** `feat(backend): shared and private notes with optimistic locking`

---

### Task 7: Системний бан — повідомлення при вході й апеляція (бекенд)

**Files:** Create `backend/src/appeals/appeals.{routes,service}.ts`; Modify `auth.routes.ts`, `dev-login.ts`, `session.middleware.ts`, `users.service.ts` (`banUser` збільшує `ban_epoch`). Test: `backend/test/appeals/appeals.test.ts`.

**Interfaces:**
- Будь-який вхід забаненого (Telegram, Google, dev) → замість 403 без сесії видається **обмежений токен апеляції**: Redis `appeal:<token>` → userId (TTL 30 хв), відповідь 403 `ACCOUNT_BANNED` з `details: { appealToken, appealSent: boolean }`; для Google-редіректу — `/login?error=ACCOUNT_BANNED&appeal=<token>`.
- `POST /api/appeals` `{ appealToken, message ≤ 2000 }` → 201; повторна в тому ж `ban_epoch` → 409 `APPEAL_EXISTS`; токен одноразовий для запису.
- Подія `appeal.created`.

- [ ] **Step 1: Failing tests:** вхід забаненого через dev-login повертає `appealToken`; апеляція створюється; друга → 409; після розбану й нового бану (`ban_epoch+1`) — знову можна; токен не дає жодного іншого доступу (`/api/me` → 401).
- [ ] **Step 2:** FAIL. **Step 3:** Реалізувати. **Step 4:** PASS. **Commit** `feat(backend): banned login notice with one appeal`

---

### Task 8: Фронтенд — подача заявки й «Мої заявки»

**Files:** Create `frontend/src/app/features/applications/{apply-dialog,my-applications}/…`, `core/applications/applications.api.ts`; Modify `game-details` (кнопка «Подати заявку» активна), shell (пункт «Мої заявки» у виді гравця), `uk.json`. Tests: specs.

- `ApplyDialog`: перелік попереджень з `WarningChip` + обов'язковий чекбокс «Я ознайомився(-лась) і погоджуюсь», відповіді на анкету (обов'язкові), повідомлення, список власних обмежень (додати/видалити, ≤ 10). Помилки з кодами біля полів/у діалозі.
- `MyApplications` (`/my-applications`): заявки за статусами, картка гри, відповіді майстра на мої обмеження, «Відкликати» (confirm), причина скасування (`games.applications.cancelReason.<reason>`).
- Сторінка гри: для учасника — бейдж «Ви учасник»; для `pending` — «Заявку подано» + відкликати; для забаненого/чорного списку — кнопка неактивна з поясненням.

- [ ] Specs: подача з непогодженими попередженнями неможлива; 409 `APPLICATION_EXISTS` показує стан «уже подано»; відкликання викликає DELETE після підтвердження. **Commit** `feat(frontend): apply to games, my applications`

---

### Task 9: Фронтенд — керування заявками й учасниками (майстер), чорний список

**Files:** Create `frontend/src/app/features/applications/game-applications/…`, `features/members/{members-panel,blacklist-page}/…`; Modify `my-games` (лічильник нових заявок), routes, `uk.json`. Tests: specs.

- `/games/:id/applications` (майстер): список заявок з відповідями на анкету, повідомленням, обмеженнями; на кожне обмеження — вибір `accepted|partial|cannot_guarantee` (+коментар для partial); «Затвердити» (попередження, якщо понад максимум), «Відхилити».
- `MembersPanel` (на сторінці гри): склад; для майстра — меню «Виключити» / «Забанити в цій грі» / «Додати в чорний список» (confirm для кожного).
- `/blacklist` (майстер): список з «Розбанити».
- Старт гри з попередженням `BELOW_MIN_PLAYERS` → діалог «Учасників менше за мінімум. Почати все одно?».

- [ ] Specs: `partial` без коментаря блокує збереження; затвердження понад максимум показує попередження; бан викликає правильний ендпоінт і прибирає учасника зі списку. **Commit** `feat(frontend): gm applications, members management, blacklist`

---

### Task 10: Фронтенд — сторінка гри для учасників, сесії, вихід, перетворення на кампанію

**Files:** Create `features/sessions/{sessions-list,session-actions,finish-session-dialog,convert-to-campaign-dialog}/…`, `features/members/leave-dialog/…`; Modify `game-details`, `uk.json`. Tests: specs.

- Сторінка гри для майстра й активних учасників: адреса, канали, `SessionsList` (минулі/майбутні, статуси, перенесені з позначкою), склад.
- Майстер: «Перенести» (дата+час у поясі гри), «Скасувати» (причина), «Завершити сесію» (присутність чекбоксами + підсумок), «Змінити розклад» (форма правила), «Перетворити на кампанію» (для ваншота).
- Учасник: «Вийти з гри» (`LeaveDialog`: «для майстра» обов'язкове ≥ 10, «для адміністрації» необов'язкове з підказкою, що інакше скопіюється).

- [ ] Specs: вихід з коротким текстом заблоковано; перенесення конвертує локальний час гри в UTC; присутність надсилається для всіх учасників. **Commit** `feat(frontend): member game page, sessions management, leaving, convert to campaign`

---

### Task 11: Фронтенд — нотатки, календар із зайнятістю

**Files:** Create `features/notes/{note-editor,shared-player-notes}/…`; Modify `availability-editor`, `account-settings` (перемикач автозайнятості), `game-details` (кнопка «Додати в мій календар» у ручному режимі), `uk.json`. Tests: specs.

- `NoteEditor` (`@Input() load/save`): textarea з автозбереженням (debounce 1 с), стан «Збережено/Зберігається/Конфлікт»; на 409 — показ обох версій і вибір «Залишити мою» (повторний PUT з новою `version`) / «Взяти актуальну».
- `SharedPlayerNotes`: моя сторінка (редагована) + сторінки інших гравців (лише читання, «колишній учасник» позначка). Майстру не показується.
- Приватна нотатка на гру — на сторінці гри; приватна нотатка на сесію — розгортається в рядку сесії.
- `AvailabilityEditor`: накладає `game-busy` інтервали поверх сітки в поясі користувача з окремим стилем (штриховка + назва гри в tooltip), не редагуються.

- [ ] Specs: конфлікт показує обидві версії; автозбереження не надсилає без змін; зайнята клітинка має окремий клас і `aria-label` з назвою гри. **Commit** `feat(frontend): notes and calendar busy time from games`

---

### Task 12: Фронтенд — повідомлення про бан і апеляція

**Files:** Create `features/auth/banned-notice/…`; Modify `login` (обробка `ACCOUNT_BANNED` з `appealToken`/`?appeal=`), `uk.json`. Test: spec.

- Екран «Ваш акаунт заблоковано адміністрацією» + форма одного повідомлення (≤ 2000) → `POST /api/appeals`; після відправки/409 — «Повідомлення вже надіслано».

- [ ] Spec: токен з query береться й не потрапляє в історію (replaceUrl); 409 показує стан «вже надіслано». **Commit** `feat(frontend): banned notice with appeal`

---

### Task 13: Фінальна перевірка

- [ ] **Step 1:** `npm test && npm run typecheck && npm run lint && npm run build -w frontend`; `docker build` трьох образів.
- [ ] **Step 2:** Ручна перевірка в браузері: майстер публікує гру → гравець (друга dev-сесія в іншому браузерному профілі/вкладці інкогніто) подає заявку з обмеженням → майстер відповідає й затверджує → гравець бачить адресу, сесії й зайнятість у календарі → майстер переносить сесію → зайнятість перенеслась → гравець виходить → доступ зник.
- [ ] **Step 3:** Оновити `docs/superpowers/backlog.md`. **Commit** `docs: plan 3 verification and backlog`
