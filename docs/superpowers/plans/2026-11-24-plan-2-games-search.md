# НРІ Асистент — План 2: Ігри, пошук, календар, профілі

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Майстер створює й публікує гру з розкладом, гравець шукає ігри за фільтрами й власним календарем вільного часу, у кожного користувача є публічний профіль з налаштуваннями приватності; пошуковики й прев'ю посилань бачать ігри та профілі.

**Architecture:** Розширення монорепо Плану 1. Чисті функції розкладу й відповідності календарю живуть у `@nri/shared` (однакові на фронті й бекенді). Бекенд додає модулі `catalog/`, `games/`, `profiles/`, `availability/`, `seo/` за тим самим шаблоном, що `users/` (routes + service + zod з `@nri/shared`). Фронтенд — нові lazy-фічі `games/`, `search/`, `profile/`, `calendar/` на signals.

**Tech Stack:** як у Плані 1 (Node 26, TS 6.0, Express 5, Drizzle + MySQL 8.4, Redis, Socket.IO, Angular 22 + Material + LESS, ngx-translate, Vitest). Нових залежностей немає: часові пояси через `Intl` (без moment/luxon).

**Spec:** `docs/superpowers/specs/2026-11-24-nri-assistant-design.md` (§2–§3, §9) + беклог `docs/superpowers/backlog.md`.

## Рішення власника для Плану 2 (2026-11-24)

- Розклад гри: дата й час першої сесії, тривалість, регулярність `none | weekly | biweekly | monthly` + дні тижня (для weekly/biweekly). Самі сесії — План 3.
- Календар гравця: тижнева сітка **вільних** інтервалів кроком 30 хв + разові «зайняті» дати; без місячних правил.
- Відповідність календарю: горизонт **4 тижні**; `full` — усі сесії гри за 4 тижні цілком у вільному часі; `partial` — щонайменше половина з них (≈2 тижні). Перемикач «показувати частково придатні».
- Фільтри пошуку: система, жанр, формат (онлайн/офлайн + місто), ваншот/кампанія, діапазон дат, календар, ціна (безкоштовні/платні/до N грн), вікова позначка, досвід, платформа, мова гри, «є вільні місця», виключення попереджень. Сортування: найближчі / нові.
- Картка гри: назва, обкладинка (URL), система й жанр, майстер, формат і місто, найближча дата, вільні місця, ціна, вікова позначка.
- Каталог систем (seed): D&D 5e (2014), D&D 5e (2024), Pathfinder 2e, Call of Cthulhu 7e, Vampire: the Masquerade V5, Cyberpunk RED, Shadowrun 6e, Warhammer Fantasy RP 4e, Blades in the Dark, Savage Worlds, Fate, GURPS, Mothership, **UESRPG** (The Elder Scrolls); плюс «Інша» (вільний текст). Жанри: фентезі, темне фентезі, хорор, кіберпанк, наукова фантастика, постапокаліпсис, стімпанк, детектив/нуар, історичний, супергерої, комедійний.
- Попередження вмісту: каталог + власні від майстра; у кожного з каталогу є коротке пояснення, яке показується підказкою по іконці (i) при наведенні/фокусі.
- Ціна в грн **за сесію**, `null` = безкоштовно. Мова гри: `uk` (за замовчуванням) | `en`. Посилання на канали гри бачать лише майстер і затверджені гравці.
- **Ідентичність:** кожен користувач має незмінний унікальний `publicId` (адреса профілю `/users/<publicId>`); `nickname` — декоративний, змінюється будь-коли, але лише на унікальний (без урахування регістру).
- Поля профілю: «про себе», місто, улюблені системи, бажані формати, досвід; кожне можна приховати (за замовчуванням усі видимі). Завжди публічні: нік, аватар, історія ігор (рейтинги — План 5).
- Вид гравця: головна — пошук. Вид майстра: головна — «Мої ігри» + «Створити гру».
- Редагування: чернетка — повністю; у статусах `recruiting`/`started` не можна змінювати систему й тип (ваншот/кампанія), решту можна (сповіщення гравцям — План 4).

## Рішення розробника (перевір)

- Щомісячна регулярність = той самий «n-й день тижня місяця», що й перша сесія (напр. «друга субота»); якщо перша сесія у 5-й день тижня місяця — «останній».
- Час гри зберігається в UTC + `timezone` гри (пояс майстра на момент створення); розгортання сесій — у поясі гри (коректно через переходи на літній/зимовий час).
- Календар гравця зберігається в поясі гравця; перевірка відповідності переводить кожну сесію в пояс гравця.
- `publicId`: 10 символів з алфавіту `23456789abcdefghjkmnpqrstuvwxyz` (без схожих символів), генерується криптографічно, незмінний.
- Учасники гри: таблиця `game_members` створюється тут (порожня до Плану 3), бо від неї залежать «вільні місця» й видимість адреси/каналів.
- Пошук — `POST /api/games/search` (тіло з фільтрами, бо календар-перевизначення не влазить у URL); сторінки гри й профілю — звичайні `GET` для SEO.
- OG-мета для ботів прев'ю — `GET /api/og/games/:id` і `/api/og/users/:publicId`; reverse proxy перенаправляє туди ботів за User-Agent (README).

## Global Constraints

- Кожен Angular-компонент — окремі `*.ts`, `*.html`, `*.less`; без `template:`/`styles:` у `.ts`.
- Весь текст UI — ключі `frontend/src/assets/i18n/uk.json`; назви систем — власні назви (не перекладаються), жанри й попередження — через ключі `genres.<slug>`, `warnings.<slug>.label`, `warnings.<slug>.hint`.
- Помилки API — коди з `ERROR_CODES` (`@nri/shared`), переклад на фронті.
- Час у БД — UTC. Бізнес-правила (статуси, вік, видимість, ліміти) — на бекенді; фронт лише відображає.
- Реєстрація з 14 років. Ігри 18+/21+ для молодших і гостей — **дані приховуються сервером** (лише `id`, `title`, учасники/майстер), фронт додатково блюрить.
- Темна тема; кольори лише через CSS-змінні; Material-кнопки використовують токени з `material-dark.scss`.
- Контрактні типи API — лише в `@nri/shared` (з Таски 1 жодних дублікатів DTO на фронті).
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build -w frontend` — зелені перед кожним комітом.

## Review Focus

1. **Перехід на літній/зимовий час:** щотижнева гра о 19:00 Europe/Kyiv лишається о 19:00 за Києвом до й після 2027-03-28 (UTC-час змінюється). Тест — Task 4.
2. **Різні часові пояси майстра й гравця:** гра о 19:00 Kyiv для гравця в Europe/Warsaw — це 18:00, і відповідність рахується за його сіткою. Тест — Task 4.
3. **Витік 18+/21+ даних:** гість і 17-річний отримують з `GET /api/games/:id` і пошуку лише `id`, `title`, майстра, `ageRating`, `restricted: true` — без опису, обкладинки, міста, ціни. Тест — Task 7, Task 9.
4. **Витік чернетки й приватних полів:** чернетку бачить лише майстер (іншим 404); `address` і `channelLinks` — лише майстру й `game_members`. Тест — Task 7.
5. **Унікальність ніку без урахування регістру й гонка:** дві одночасні зміни на `Saruman`/`saruman` → одна успішна, друга 409 `NICKNAME_TAKEN`. Тест — Task 3.

---

## File Structure

```
shared/src/
  contracts/me.ts            MeDto, IdentityDto, UserRole/Status, IdentityProvider (перенесено з фронта)
  contracts/catalog.ts       SystemDto, GenreDto, ContentWarningDto, CatalogDto
  contracts/games.ts         GameDto, GameCardDto, enums, gameInputSchema, searchFiltersSchema
  contracts/profile.ts       PublicProfileDto, profileInputSchema, privacy keys
  contracts/availability.ts  AvailabilityDto, availabilityInputSchema
  schedule/occurrences.ts    expandOccurrences
  schedule/fit.ts            availabilityFit
  schedule/tz.ts             zonedToUtc, utcToZoned (Intl-based)
backend/src/
  db/schema/catalog.ts  games.ts  profiles.ts  availability.ts
  db/migrations/0002_* … (генеруються) + 0003_catalog_seed.sql (ручна)
  catalog/catalog.routes.ts  catalog.service.ts
  users/nickname.ts                         publicId генерація, зміна ніку
  profiles/profiles.routes.ts  profiles.service.ts
  availability/availability.routes.ts  availability.service.ts
  games/games.routes.ts  games.service.ts  games.visibility.ts  games.search.ts
  seo/seo.routes.ts
frontend/src/app/
  core/catalog/catalog.store.ts
  core/seo/seo.service.ts
  features/games/game-form/…  my-games/…  game-details/…
  features/search/search-page/…  search-filters/…  game-card/…
  features/profile/profile-page/…  profile-edit/…
  features/calendar/availability-editor/…
  shared/warning-chip/…                    чип попередження з (i)-підказкою
```

---

### Task 1: Спільні контракти, збирання `shared`, collation ніку

**Files:**
- Create: `shared/src/contracts/me.ts`; Modify: `shared/src/index.ts`
- Modify: `frontend/src/app/core/auth/me.model.ts` → реекспорт з `@nri/shared` (файл лишається тонким реекспортом або видаляється з оновленням імпортів)
- Modify: `backend/src/users/users.service.ts` (тип `MeDto` з `@nri/shared`)
- Modify: `scripts/run-workspaces.mjs` або root `package.json` — перед `test`/`typecheck` збирати `shared`
- Create: `backend/src/db/migrations/0002_nickname_collation.sql` (через drizzle або custom migration)
- Test: `backend/test/db/collation.test.ts`

**Interfaces:**
- Produces: `MeDto`, `IdentityDto`, `UserRole`, `UserStatus`, `IdentityProvider` з `@nri/shared`; `users.nickname` з collation `utf8mb4_0900_ai_ci` явно.

- [ ] **Step 1:** Тест `collation.test.ts`: створити користувача з ніком `Saruman`, вставка іншого з `saruman` кидає дубль; `SHOW FULL COLUMNS FROM users LIKE 'nickname'` → `Collation === 'utf8mb4_0900_ai_ci'`. Run `npm test -w backend -- collation` → FAIL (collation не задана явно в `nri_test`).
- [ ] **Step 2:** Міграція `ALTER TABLE users MODIFY nickname varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL` (+ відповідна правка схеми Drizzle, щоб `db:generate` не створював дрейфу). Run → PASS.
- [ ] **Step 3:** Перенести типи в `shared/src/contracts/me.ts`, бек і фронт імпортують з `@nri/shared`. Кореневі `npm test` і `npm run typecheck` спершу виконують `npm run build -w shared`. Перевірка: змінити тип у shared → root typecheck бачить зміну без ручного build.
- [ ] **Step 4:** `npm test && npm run typecheck && npm run lint` → зелене. **Commit** `chore: shared api contracts, shared prebuild, explicit nickname collation`

---

### Task 2: Дрібні правки з беклогу (OAuth, вік на фронті, банер)

**Files:** Modify `backend/src/auth/auth.routes.ts`, `backend/src/auth/oauth-nav.ts`, `frontend/src/app/shared/forms/profile-validators.ts`, `frontend/src/app/core/auth/auth.store.ts`. Tests: `backend/test/auth/google.test.ts`, `frontend/src/app/shared/forms/profile-validators.spec.ts`, `frontend/src/app/core/auth/auth.store.spec.ts`.

- [ ] **Step 1: Failing tests:**
  - `GET /api/auth/google/start?mode=link` без сесії → 302 на `/login?error=UNAUTHENTICATED` (не `/account`).
  - callback, де `linkIdentity` кидає `AppError(404,'NOT_FOUND')` → 302 `/account?error=NOT_FOUND` (будь-яка `AppError` → редірект).
  - rate-limited `GET /API/auth/google/start` (інший регістр) → 302, не JSON.
  - `minAgeValidator` з `timezone='Pacific/Kiritimati'` і годинником `2026-11-23T11:00Z`: дата народження `2012-11-24` → валідна (там уже 24.11), з `timezone='UTC'` → `ageTooLow`. Валідатор отримує пояс з форми (`minAgeValidator(tzControlName)` або фабрика `minAgeValidatorFor(() => tz)`).
  - `AuthStore`: після 5xx (`failed=true`) подія `auth-error` + 200 → `loadFailed()` === false.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Реалізувати (сьогодні в поясі — та сама логіка, що `localDate` на бекенді; винести `localDate(d, tz)` у `@nri/shared` і використати з обох боків). **Step 4:** Run → PASS. **Commit** `fix: oauth redirect edge cases, tz-aware age validator, banner reset`

---

### Task 3: `publicId` і змінний декоративний нік

**Files:**
- Modify: `backend/src/db/schema/users.ts` (+ `publicId char(10) unique not null`), migration з backfill для наявних рядків
- Create: `backend/src/users/nickname.ts`; Modify: `identity.service.ts` (створення користувача генерує `publicId`), `dev-login.ts`, `users.service.ts`, `users.routes.ts`
- Modify: `shared/src/contracts/me.ts` (`MeDto.publicId: string`), `shared/src/schemas/auth.ts` (`changeNicknameSchema = completeProfileSchema.pick({nickname})`)
- Frontend: `account-settings` — поле зміни ніку; посилання «Мій профіль» → `/users/<publicId>` у меню акаунта
- Test: `backend/test/users/nickname.test.ts`, `frontend/.../account-settings.spec.ts`

**Interfaces:**
- Produces: `generatePublicId(): string` (10 символів з алфавіту `23456789abcdefghjkmnpqrstuvwxyz`, `crypto.randomInt`); `changeNickname(deps, userId, nickname): Promise<MeDto>`; `PATCH /api/me/nickname` `{nickname}` (requireActive) → `MeDto`; 409 `NICKNAME_TAKEN`. Зміна ніку — `logEvent('user.nickname_changed')`, evict кешу сесії не потрібен (нік не в SessionUser).

- [ ] **Step 1: Failing tests:** новий користувач має `publicId` довжини 10 з алфавіту; міграція заповнила `publicId` для всіх наявних (тест: рядок, вставлений до міграції у фікстурі — достатньо перевірити `NOT NULL` + унікальність); `PATCH /api/me/nickname` → 200 і `MeDto.nickname` змінено, `publicId` незмінний; **(Review Focus 5)** `Promise.all` двох запитів від різних користувачів на `Saruman` і `saruman` → рівно один 200, один 409; власний нік з іншим регістром (`Saruman`→`SARUMAN`) → 200; pending-користувач → 403 `PROFILE_INCOMPLETE`.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізувати (колізія `publicId` → повтор генерації до 5 разів). **Step 4:** PASS; фронт-спек: зміна ніку викликає `PATCH` і оновлює `AuthStore.me()`. **Commit** `feat: immutable publicId, editable unique nickname`

---

### Task 4: Розклад і відповідність календарю (`@nri/shared`)

**Files:** Create `shared/src/schedule/{tz,occurrences,fit}.ts`, `shared/src/contracts/availability.ts`; tests `shared/src/schedule/*.test.ts`.

**Interfaces:**
- `type Recurrence = 'none' | 'weekly' | 'biweekly' | 'monthly'`; `type Weekday = 0|1|2|3|4|5|6` (0 = понеділок).
- `interface ScheduleInput { startsAt: string /* ISO UTC */; durationMinutes: number; recurrence: Recurrence; weekdays: Weekday[] /* для weekly/biweekly; [] інакше */; timezone: string }`
- `expandOccurrences(s: ScheduleInput, fromUtc: Date, toUtc: Date): { start: Date; end: Date }[]` — сесії, що починаються в `[fromUtc, toUtc)`, локальний час гри зберігається через DST; `weekly` — кожен обраний день о локальному часі першої сесії, починаючи з `startsAt`; `biweekly` — те саме з кроком 2 тижні від тижня першої сесії; `monthly` — n-й день тижня місяця першої сесії (5-й → останній).
- `interface AvailabilityDto { timezone: string; slots: { weekday: Weekday; startMin: number; endMin: number }[]; busyDates: string[] /* YYYY-MM-DD */ }` (startMin/endMin кратні 30, 0 ≤ start < end ≤ 1440); `availabilityInputSchema` (zod) — перевіряє кратність, перетини й сортує/зливає суміжні.
- `availabilityFit(occ: {start: Date; end: Date}[], a: AvailabilityDto): 'full' | 'partial' | 'none'` — сесія підходить, якщо в поясі гравця вона цілком в одному інтервалі свого дня (сесія через північ — у двох суміжних інтервалах, що з'єднуються о 24:00/0:00) і її дата не в `busyDates`; `full` = усі, `partial` = ≥ половина (і не всі), інакше `none`; порожній список сесій → `none`.
- `FIT_HORIZON_DAYS = 28`.

- [ ] **Step 1: Failing tests** (`occurrences.test.ts`, `fit.test.ts`):
  - weekly Вт+Чт, перша сесія `2026-12-01T17:00:00Z` (19:00 Kyiv), `[2026-12-01, 2026-12-15)` → 4 сесії: 01, 03, 08, 10 грудня о 17:00Z.
  - **(Review Focus 1)** weekly Нд о 19:00 Kyiv з `2027-03-21T17:00:00Z` → наступна `2027-03-28T16:00:00Z` (19:00 за літнім часом).
  - biweekly пропускає непарні тижні; monthly «друга субота» з `2026-12-12` → `2027-01-09`, `2027-02-13`; перша сесія 5-а субота → наступна — остання субота місяця.
  - `none` → рівно одна сесія, якщо в діапазоні.
  - **(Review Focus 2)** сесія 19:00–23:00 Kyiv; гравець `Europe/Warsaw` зі слотом Вт 18:00–22:00 → `full`; зі слотом Вт 18:30–22:00 → `none`.
  - 4 сесії, 2 підходять → `partial`; 1 з 4 → `none`; дата сесії в `busyDates` → не підходить; сесія 22:00–02:00 при слотах Пт 20:00–24:00 + Сб 0:00–03:00 → підходить.
  - `availabilityInputSchema`: `startMin=15` → помилка; перетин інтервалів → помилка; суміжні `[600,720]+[720,840]` зливаються.
- [ ] **Step 2:** `npm test -w shared` → FAIL. **Step 3:** Реалізувати через `Intl.DateTimeFormat(...).formatToParts` (без сторонніх бібліотек). **Step 4:** PASS. **Commit** `feat(shared): schedule expansion and availability fit`

---

### Task 5: Каталог систем, жанрів, попереджень

**Files:** Create `backend/src/db/schema/catalog.ts`, migration (таблиці) + `0003_catalog_seed.sql` (ручна seed-міграція, ідемпотентна через `INSERT IGNORE` по `slug`), `backend/src/catalog/catalog.{routes,service}.ts`, `shared/src/contracts/catalog.ts`; Modify `frontend/src/assets/i18n/uk.json`; Create `frontend/src/app/core/catalog/catalog.store.ts`, `frontend/src/app/shared/warning-chip/warning-chip.{ts,html,less}`. Tests: `backend/test/catalog/catalog.test.ts`, `catalog.store.spec.ts`, `warning-chip.spec.ts`.

**Interfaces:**
- Таблиці: `genres(id, slug unique, sort)`, `game_systems(id, slug unique, name varchar(80), default_genre_id FK genres, sort, is_active bool)`, `content_warnings(id, slug unique, sort)`.
- `CatalogDto = { systems: {id, slug, name, defaultGenreId}[]; genres: {id, slug}[]; contentWarnings: {id, slug}[] }`; `GET /api/catalog` (публічний) → `CatalogDto`, кеш у Redis `catalog:v1` на 1 год.
- Seed: системи й жанри з «Рішень власника» (slug-и латиницею: `dnd5e-2014`, `dnd5e-2024`, `pf2e`, `coc7e`, `vtm-v5`, `cyberpunk-red`, `shadowrun6e`, `wfrp4e`, `blades`, `savage-worlds`, `fate`, `gurps`, `mothership`, `uesrpg`; жанри `fantasy`, `dark-fantasy`, `horror`, `cyberpunk`, `scifi`, `postapoc`, `steampunk`, `noir`, `historical`, `superhero`, `comedy`); типові жанри: D&D/PF2e/WFRP/UESRPG → fantasy (WFRP → dark-fantasy), CoC → horror, VtM → horror, Cyberpunk RED/Shadowrun → cyberpunk, Blades → dark-fantasy, Mothership → scifi, решта → fantasy. Попередження: `violence`, `gore`, `character-death`, `self-harm`, `sexual-content`, `drugs`, `phobias`, `abuse`, `discrimination`, `body-horror`.
- `uk.json`: `genres.<slug>`, `warnings.<slug>.label`, `warnings.<slug>.hint` (одне коротке речення-пояснення українською).
- `CatalogStore` (signals): `catalog()`, `load()` (один раз), `systemName(id)`, `genreKey(id)`.
- `WarningChip` (`@Input() slug | custom text`): чип з назвою + іконка (i) з `matTooltip` = `warnings.<slug>.hint`; підказка доступна з клавіатури (focusable, `aria-describedby`); власні попередження — без (i).

- [ ] **Step 1: Failing tests:** `GET /api/catalog` → 15 систем включно з `uesrpg`, 11 жанрів, 10 попереджень; кожна система має `defaultGenreId`; повторний запуск seed-міграції не дублює; кожен slug має переклади `label` і `hint` в `uk.json` (тест у фронті ітерує `CatalogDto`-фікстуру); `WarningChip` рендерить tooltip-текст з ключа `hint`.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізувати. **Step 4:** PASS. **Commit** `feat: game catalog with genres and content warning hints`

---

### Task 6: Профіль, приватність, календар вільного часу (бекенд)

**Files:** Create `backend/src/db/schema/{profiles,availability}.ts` + migration, `backend/src/profiles/profiles.{routes,service}.ts`, `backend/src/availability/availability.{routes,service}.ts`, `shared/src/contracts/profile.ts`. Tests: `backend/test/profiles/profiles.test.ts`, `backend/test/availability/availability.test.ts`.

**Interfaces:**
- `user_profiles(user_id PK FK users cascade, bio text null, city varchar(80) null, favorite_system_ids json number[] default [], preferred_formats json ('online'|'offline')[] default [], experience enum('none','beginner','intermediate','veteran') null, privacy json default {})`; privacy ключі `bio | city | favoriteSystems | preferredFormats | experience` → `boolean` (відсутній = видимий).
- `availability_slots(user_id, weekday tinyint, start_min smallint, end_min smallint)`, `availability_busy_dates(user_id, date)`; часовий пояс — `users.timezone`.
- `profileInputSchema` (bio ≤ 1000, city ≤ 80, favoriteSystemIds ≤ 10 існуючих id, privacy); `PATCH /api/me/profile` (requireActive) → `ProfileDto` (свій, повний); `GET /api/me/profile`.
- `PublicProfileDto = { publicId, nickname, avatarUrl, status, bio?, city?, favoriteSystemIds?, preferredFormats?, experience?, gamesAsGm: GameCardDto[], gamesAsPlayer: GameCardDto[] }` — приховані поля відсутні в JSON (не `null`); видалений користувач → `{ publicId, status: 'deleted' }` без нічого іншого; `GET /api/users/:publicId` (публічний), невідомий → 404. У цій таскі `gamesAsGm`/`gamesAsPlayer` завжди порожні масиви (тип елемента — `unknown[]`-заглушка); Task 7 замінює їх на `GameCardDto[]` з ігор у статусах `recruiting|started|finished`.
- `GET /api/me/availability` → `AvailabilityDto` (timezone = `users.timezone`); `PUT /api/me/availability` (`availabilityInputSchema`) замінює все атомарно.

- [ ] **Step 1: Failing tests:** приховане `city` відсутнє в публічному JSON, але є в `GET /api/me/profile`; `favoriteSystems` видимі за замовчуванням; видалений користувач → лише `publicId`+`status`; `PUT` availability з перетином → 400 `VALIDATION`; `PUT` замінює попередні слоти; чужий календар недоступний (немає публічного endpoint).
- [ ] **Step 2:** FAIL. **Step 3:** Реалізувати. **Step 4:** PASS. **Commit** `feat(backend): public profiles with privacy, player availability`

---

### Task 7: Ігри — схема, CRUD, статуси, видимість

**Files:** Create `backend/src/db/schema/games.ts` + migration, `backend/src/games/games.{routes,service,visibility}.ts`, `shared/src/contracts/games.ts`; Modify `shared/src/errors.ts` (нові коди). Tests: `backend/test/games/games.test.ts`, `backend/test/games/visibility.test.ts`, `shared/src/contracts/games.test.ts`.

**Interfaces:**
- `games`: `id`, `gm_user_id FK`, `title varchar(120)`, `description text`, `system_id FK null`, `system_other varchar(80) null` (рівно одне з двох), `genre_id FK`, `format enum('online','offline')`, `city varchar(80) null` (обов'язкове для offline), `address varchar(255) null`, `platform varchar(60) null`, `kind enum('oneshot','campaign')`, `starts_at datetime`, `duration_minutes smallint` (30–720, крок 30), `recurrence enum('none','weekly','biweekly','monthly')` (`oneshot` → лише `none`), `weekdays json`, `timezone varchar(64)`, `min_players`/`max_players tinyint` (1 ≤ min ≤ max ≤ 20), `price_uah int null`, `age_rating enum('none','18+','21+')`, `experience enum('any','beginner','experienced')`, `language enum('uk','en')`, `requirements text null`, `cover_url varchar(512) null` (лише `https://`), `channel_links json` (`{label, url}[]` ≤ 5, `https://`), `application_questions json` (≤ 10 рядків ≤ 300), `custom_warnings json` (≤ 10 рядків ≤ 60), `status enum('draft','recruiting','started','finished','cancelled')`, `show_when_full bool`, `published_at`/`started_at`/`finished_at`/`cancelled_at`, `created_at`, `updated_at`; індекси `(status, starts_at)`, `(gm_user_id)`. `game_content_warnings(game_id, warning_id)` PK. `game_members(game_id, user_id, joined_at)` PK (заповнюється в Плані 3).
- `gameInputSchema` (zod, у shared) з правилами вище; `GameDto` (повний для майстра/учасника), `GameCardDto` (картка), `RestrictedGameDto = { id, title, gm: {publicId, nickname, avatarUrl}, ageRating, restricted: true }`.
- Ендпоінти (`/api/games`): `POST /` (requireActive) → чернетка; `PATCH /:id` (лише майстер); `POST /:id/publish` (`draft→recruiting`, вимагає `starts_at` у майбутньому); `POST /:id/start` (`recruiting→started`, без перевірки мін/макс); `POST /:id/finish` (`started→finished`); `POST /:id/cancel` (`draft|recruiting|started→cancelled`); `GET /:id` (публічний з правилами видимості); `GET /mine` (requireActive) — ігри користувача як майстра (усі статуси).
- Нові коди помилок: `GAME_INVALID_TRANSITION` (409), `GAME_FIELD_LOCKED` (409, details `{field}`), `AGE_RESTRICTED_CREATE` (403), `GAME_IN_PAST` (422).
- `visibility.ts`: `toGameView(game, viewer: SessionUser | null, isMember: boolean): GameDto | GameCardDto-подібне | RestrictedGameDto` — єдине місце правил.
- Події: `game.created`, `game.published`, `game.started`, `game.finished`, `game.cancelled`.

- [ ] **Step 1: Failing tests:**
  - чернетка + publish → `recruiting`; publish з `starts_at` у минулому → 422 `GAME_IN_PAST`; `finish` з `recruiting` → 409 `GAME_INVALID_TRANSITION`.
  - `PATCH` `system_id` у `recruiting` → 409 `GAME_FIELD_LOCKED {field:'systemId'}`; зміна `title` у `recruiting` → 200; у `draft` можна все.
  - 16-річний майстер створює гру `18+` → 403 `AGE_RESTRICTED_CREATE`.
  - **(Review Focus 4)** чужа чернетка → 404; `address`/`channelLinks` відсутні для стороннього активного користувача, присутні для майстра й для `game_members`.
  - **(Review Focus 3)** гра `18+`: гість і 17-річний отримують рівно ключі `id,title,gm,ageRating,restricted`; 18-річний — повний вигляд (без приватних полів); гра `21+` для 19-річного — restricted.
  - `oneshot` з `recurrence='weekly'` → 400 `VALIDATION`; offline без `city` → 400; `cover_url` `http://` → 400.
  - `GET /api/users/:publicId` майстра тепер містить його опубліковану гру в `gamesAsGm` (`GameCardDto`), а чернетку — ні; учасник з `game_members` бачить гру в `gamesAsPlayer`.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізувати. **Step 4:** PASS. **Commit** `feat(backend): games with lifecycle, edit locks and visibility rules`

---

### Task 8: Пошук ігор (бекенд)

**Files:** Create `backend/src/games/games.search.ts`; Modify `games.routes.ts`, `shared/src/contracts/games.ts` (`searchFiltersSchema`, `SearchResultDto`). Test: `backend/test/games/search.test.ts`.

**Interfaces:**
- `POST /api/games/search` (публічний, CSRF як завжди) тіло `searchFiltersSchema`: `{ systemIds?, genreIds?, format?, city?, kind?, dateFrom?, dateTo?, priceMode?: 'any'|'free'|'paid', priceMax?, ageRatings?, experience?, platform?, language?, hasFreeSlots?: boolean, excludeWarningIds?, calendar?: { mode: 'off'|'mine'|'custom'; availability?: AvailabilityDto; includePartial?: boolean }, sort: 'soonest'|'newest', cursor?: string, limit?: number (1–50, default 20) }` → `{ items: (GameCardDto & { fit?: 'full'|'partial' } | RestrictedGameDto)[], nextCursor: string | null }`.
- Видимі статуси: `recruiting`; `started` лише з `show_when_full=true`. «Вільні місця» = `max_players - count(game_members)`; `hasFreeSlots=true` → `> 0`.
- `calendar.mode='mine'` без сесії → 401; `'mine'` бере збережений календар; фільтр рахує `availabilityFit` по `expandOccurrences(game, now, now + FIT_HORIZON_DAYS)`; `full` завжди проходить, `partial` — лише з `includePartial`.
- Реалізація: SQL-префільтр за всіма полями крім календаря, з `LIMIT` 200 кандидатів на сторінку, далі календарний фільтр у пам'яті; курсор — base64url `{sortKey, id}`. Ігри 18+/21+ для гостя/неповнолітнього повертаються як `RestrictedGameDto` (не відфільтровуються).
- `fit` у картці присутній лише коли календар увімкнено.

- [ ] **Step 1: Failing tests:** фільтр за системою/жанром/форматом/містом (без урахування регістру); `priceMode='free'` → лише `price_uah IS NULL`; `excludeWarningIds` прибирає ігри з будь-яким із них; `hasFreeSlots` з 2 учасниками при `max=2` → гра зникає, з `show_when_full` і `started` — видно лише без `hasFreeSlots`; календар `mine`: гра Вт 19:00–23:00 Kyiv, гравець зі слотом Вт 18:00–23:30 → `fit:'full'`; гравець без потрібного слоту → відсутня; `includePartial`; чернетки й скасовані ніколи не з'являються; пагінація: 25 ігор, `limit=20` → 20 + курсор → 5 і `nextCursor=null`, без дублікатів; **(Review Focus 3)** 18+ гра в пошуку гостя має рівно ключі restricted-вигляду.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізувати. **Step 4:** PASS. **Commit** `feat(backend): game search with filters, calendar fit and cursor paging`

---

### Task 9: SEO для ігор і профілів (бекенд)

**Files:** Create `backend/src/seo/seo.routes.ts`; Modify `app.ts`, `README.md` (nginx: `/sitemap.xml`, `/robots.txt` → бекенд; боти прев'ю за `map $http_user_agent` → `/api/og/...`). Test: `backend/test/seo/seo.test.ts`.

**Interfaces:**
- `GET /sitemap.xml` (монтується поза `/api`, без CSRF/сесії): головна, `/about`, усі ігри `recruiting|started` **без** вікової позначки (`/games/:id`), профілі активних користувачів (`/users/:publicId`); `lastmod` з `updated_at`.
- `GET /robots.txt`: `Allow: /`, `Disallow: /account`, `Disallow: /api/`, `Sitemap: ${PUBLIC_BASE_URL}/sitemap.xml`.
- `GET /api/og/games/:id`, `GET /api/og/users/:publicId` → мінімальний HTML з `<title>`, `og:title`, `og:description` (≤ 200 символів), `og:image` (обкладинка/аватар, якщо є), `og:url`, `twitter:card`; ігри 18+/21+ і чернетки → нейтральні мета без опису + `<meta name="robots" content="noindex">`; HTML-екранування всіх значень.

- [ ] **Step 1: Failing tests:** sitemap містить гру без позначки й не містить 18+ і чернетку; OG для гри з `<script>` у назві екранує його; OG 18+ гри не містить опису й має `noindex`; robots містить рядок `Sitemap:` з `PUBLIC_BASE_URL`.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізувати. **Step 4:** PASS. **Commit** `feat(backend): sitemap, robots and og previews`

---

### Task 10: Фронтенд — форма гри, «Мої ігри», вид майстра

**Files:** Create `frontend/src/app/features/games/{game-form,my-games}/…`, `frontend/src/app/core/games/games.api.ts`; Modify `app.routes.ts`, `layout/shell` (головна за видом), `uk.json`. Tests: `game-form.spec.ts`, `my-games.spec.ts`, `shell.spec.ts`.

**Interfaces:**
- Маршрути: `/games/new`, `/games/:id/edit` (activeGuard), `/my-games` (activeGuard); у виді майстра `/` показує `MyGames`, у виді гравця — `SearchPage` (Task 11).
- `GameForm`: reactive form за `gameInputSchema` (помилки біля полів), вибір системи → підставляє типовий жанр (якщо користувач жанр ще не міняв), «Інша» → поле назви; формат offline → обов'язкове місто й адреса (з поясненням «адресу бачать лише затверджені гравці»); розклад: дата+час (пояс користувача), тривалість, регулярність, дні тижня; попередження — мультивибір чипів з `WarningChip` + власні; канали; питання анкети; кнопки «Зберегти чернетку», «Опублікувати»; у `recruiting/started` поля системи й типу `disabled` з підказкою; користувачу < 18 вікові позначки 18+/21+ недоступні.
- `MyGames`: список карток з бейджем статусу й діями за статусом (редагувати, опублікувати, почати, завершити, скасувати — з діалогом підтвердження).

- [ ] **Step 1: Failing tests:** вибір системи `cyberpunk-red` ставить жанр `cyberpunk`, але не перезаписує жанр, обраний вручну; offline без міста — кнопка опублікувати недоступна, помилка біля поля; редагування гри в `recruiting` — система `disabled`; 409 `GAME_FIELD_LOCKED` показує переклад біля поля; вид майстра на `/` рендерить `MyGames`.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізувати. **Step 4:** PASS (+ lint, build). **Commit** `feat(frontend): game form, my games, gm home`

---

### Task 11: Фронтенд — пошук, картки, сторінка гри

**Files:** Create `frontend/src/app/features/search/{search-page,search-filters,game-card}/…`, `frontend/src/app/features/games/game-details/…`; Modify `app.routes.ts`, `uk.json`. Tests: `search-page.spec.ts`, `game-card.spec.ts`, `game-details.spec.ts`.

**Interfaces:**
- `/` (вид гравця, також для гостей) → `SearchPage`; `/games/:id` → `GameDetails` (публічний).
- Фільтри синхронізуються з query-параметрами URL (крім `calendar.custom`); для залогіненого з непорожнім календарем режим за замовчуванням `mine`; «Змінити для цього пошуку» відкриває редактор календаря (Task 12) у режимі `custom` — збережений календар не змінюється; перемикач «показувати частково придатні».
- `GameCard`: поля з рішень власника + бейдж `fit` («Підходить» / «Частково»); `RestrictedGameDto` → картка з блюром і текстом `games.restricted.<ageRating>` (для гостя — заклик увійти).
- Нескінченне довантаження за `nextCursor`; порожній стан і помилка мережі з кнопкою повтору.
- `GameDetails`: повна інформація, попередження через `WarningChip`, обкладинка з `alt`, кнопка «Подати заявку» — неактивна з підказкою «з'явиться найближчим часом» (План 3); для майстра — кнопка «Редагувати».

- [ ] **Step 1: Failing tests:** зміна фільтра оновлює URL і робить новий запит з курсором скинутим; календар за замовчуванням `mine` для користувача зі слотами і `off` для гостя; кастомний календар не викликає `PUT /api/me/availability`; restricted-картка не рендерить опис навіть якщо поле випадково присутнє; довантаження додає елементи без дублікатів.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізувати. **Step 4:** PASS. **Commit** `feat(frontend): game search, cards and details`

---

### Task 12: Фронтенд — профіль, приватність, календар, SEO-мета

**Files:** Create `frontend/src/app/features/profile/{profile-page,profile-edit}/…`, `frontend/src/app/features/calendar/availability-editor/…`, `frontend/src/app/core/seo/seo.service.ts`; Modify `app.routes.ts`, `account-settings` (посилання на редагування профілю й календаря), `uk.json`. Tests: `profile-page.spec.ts`, `profile-edit.spec.ts`, `availability-editor.spec.ts`, `seo.service.spec.ts`.

**Interfaces:**
- `/users/:publicId` → `ProfilePage` (публічний; видалений → `user.deleted`); `/profile/edit` (activeGuard) → `ProfileEdit` (поля + перемикач видимості біля кожного); `/calendar` (activeGuard) → `AvailabilityEditor` у режимі збереження.
- `AvailabilityEditor` (`@Input() mode: 'save' | 'custom'`, `@Output() changed: AvailabilityDto`): тижнева сітка 7 × 48 клітинок по 30 хв (виділення протягуванням миші й клавіатурою), список зайнятих дат (datepicker), пояс — з профілю; у режимі `save` → `PUT /api/me/availability`.
- `SeoService.set({ titleKey | title, description?, image?, noindex? })` — оновлює `Title`, `meta[name=description]`, `og:*`, `robots`; використовують `GameDetails` (18+ → `noindex`) і `ProfilePage`.

- [ ] **Step 1: Failing tests:** приховане поле не рендериться на чужому профілі, але перемикач видимості є в редагуванні; протягування з Вт 19:00 до Вт 23:00 дає слот `{weekday:1, startMin:1140, endMin:1380}`; клавіатурне виділення (стрілки + пробіл) працює; `SeoService.set({noindex:true})` додає `robots=noindex`, повторний виклик без нього — прибирає.
- [ ] **Step 2:** FAIL. **Step 3:** Реалізувати. **Step 4:** PASS. **Commit** `feat(frontend): profiles, privacy, availability editor, seo meta`

---

### Task 13: Фінальна перевірка

- [ ] **Step 1:** `npm test && npm run typecheck && npm run lint && npm run build -w frontend` → усе зелене; `docker build` трьох образів → успішно.
- [ ] **Step 2:** Ручна перевірка в браузері (dev-сервери): створити гру як майстер (вид майстра) → опублікувати → знайти як інший користувач з календарем → перевірити бейдж «Підходить»; 18+ гра для гостя — блюр; профіль за `/users/<publicId>` з прихованим полем; зміна ніку.
- [ ] **Step 3:** Оновити `docs/superpowers/backlog.md` (виконані пункти — закреслити). **Commit** `docs: plan 2 verification and backlog`
