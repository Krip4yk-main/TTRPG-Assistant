# НРІ Асистент — План 1: Фундамент (монорепо, автентифікація, каркаси FE/BE/бота)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Робочий монорепозиторій, де користувач може увійти через Telegram, Google або dev-вхід, завершити реєстрацію (нік + дата народження), прив'язати/відв'язати способи входу, видалити акаунт, а фронтенд, бекенд, бот і вебсокет з'єднані між собою.

**Architecture:** npm workspaces: `shared/` (Zod-схеми, вікові правила), `backend/` (Express 5 + Drizzle/MySQL + Redis + Socket.IO), `frontend/` (Angular 22, standalone, signals, LESS), `bot/` (grammY, ходить у бекенд через внутрішній API з ключем). Фронт і бек живуть на **одному origin** (у dev — через Angular proxy `/api` і `/socket.io`, у prod — через reverse proxy), тому куки `SameSite=Lax` і вбудований XSRF Angular працюють без CORS.

**Tech Stack:** Node 24, TypeScript **6.0.x** (Angular 22 вимагає `>=6.0 <6.1` — однакова версія в усьому репо), Angular 22.3 + Angular Material 22.3, Express 5.3, drizzle-orm 0.45 + drizzle-kit 0.31 + mysql2, ioredis 6, socket.io 4.8, grammy 1.48, zod 4, arctic 3 (OAuth), Vitest (BE/shared/FE), supertest.

**Spec:** `docs/superpowers/specs/2026-11-24-nri-assistant-design.md`

## Дорожня карта планів

| План | Зміст | Залежить від |
|---|---|---|
| **1. Фундамент (цей)** | Монорепо, env, БД-каркас, сесії, Telegram/Google/dev-вхід, прив'язка, профіль-мінімум, видалення акаунта, власник, FE-оболонка з темою та i18n, бот-каркас, Socket.IO з автентифікацією, таблиця `events` | — |
| 2. Ігри та пошук | Каталог систем/жанрів, гра (статуси, форма, вікові позначки, попередження, блюр), пошук з фільтрами, календар гравця як дефолтний фільтр, профілі та приватність, перемикач «майстер/гравець», SEO (Meta, sitemap, OG для ботів) | 1 |
| 3. Заявки, учасники, сесії | Заявки, обмеження гравця, бани в грі, чорний список майстра, вихід з гри, кампанії та сесії з правилом регулярності, присутність | 2 |
| 4. Сповіщення та реальний час | Таблиця задач + планувальник, сповіщення в застосунку, `isViewed`, оновлення без зсуву, бот: сповіщення з кнопками, нагадування 24 год/1 год, подяка за жанром | 3 |
| 5. Оцінки, модерація, адмінка | Оцінки (сесія/кампанія, середнє на оцінювача, пачки по 5 від ≥3 людей), скарги + щоденне зведення, санкції, детектор (30/90 днів), адмінка, ролі модераторів, Discord OAuth (резерв) | 4 |

## Global Constraints

- Кожен Angular-компонент — окремі `*.ts`, `*.html`, `*.less`. **Заборонено** `template:` і `styles:` у `.ts` (перевіряє ESLint-правило з Task 1).
- `.env` у `backend/`, `frontend/`, `bot/` — у `.gitignore`. Поруч `.env.template`: усі ключі без значень, над кожним коментар «що це і де взяти».
- Лише MySQL (JSON-колонки), без MongoDB. Redis — кеш, сесії, rate limit, адаптер Socket.IO.
- Час у БД — UTC (`DATETIME` + драйвер з `timezone: 'Z'`). Часовий пояс користувача за замовчуванням `Europe/Kyiv`.
- Мінімальний вік реєстрації — **14 років**. Дату народження можна змінювати не частіше ніж раз на **30 днів**.
- Токен сесії: 32 випадкові байти (base64url), у БД — лише SHA-256 хеш. Кука `nri_sid`: `httpOnly`, `Secure` (крім dev), `SameSite=Lax`, `Path=/`, термін 30 днів (ковзний).
- CSRF: кука `nri_csrf` (не httpOnly) + заголовок `X-CSRF-Token` на всіх не-GET запитах.
- Dev-вхід: лише `NODE_ENV=development` **і** `DEV_LOGIN_ENABLED=true` **і** `req.socket.remoteAddress` ∈ {`127.0.0.1`, `::1`, `::ffff:127.0.0.1`} (заголовки `X-Forwarded-*` ігноруються). Вхід в акаунт власника — лише з `DEV_OWNER_KEY`, порівняння `crypto.timingSafeEqual`.
- Бізнес-правила перевіряє бекенд; фронт лише відображає.
- Мова інтерфейсу й бота — українська через ключі i18n (жодного хардкоду тексту в шаблонах).
- Тексти помилок API — коди (`IDENTITY_TAKEN`, `AGE_TOO_LOW` …), переклад — на фронті.

## Review Focus

1. **Підроблені або протерміновані дані Telegram** (змінене поле, `auth_date` старше 24 год) → 401 `TELEGRAM_AUTH_INVALID`, користувач не створюється. Тест — Task 6.
2. **Dev-вхід з підробленим `X-Forwarded-For: 127.0.0.1`** з не-локальної адреси або при `NODE_ENV=production` → 404 (маршрут ніби не існує). Тест — Task 8.
3. **Межа віку:** народився рівно 14 років тому сьогодні → дозволено; на день менше → `AGE_TOO_LOW`. Тест — Task 2.
4. **Бан після входу:** у забаненого користувача всі сесії (і кеш у Redis) недійсні вже на наступному запиті. Тест — Task 5.
5. **Відв'язування останнього способу входу** → 409 `LAST_IDENTITY`. Тест — Task 9.

---

## File Structure

```
package.json                 workspaces, спільні скрипти
tsconfig.base.json           strict, target ES2023
eslint.config.mjs            + правило заборони inline template/styles
.prettierrc
docker-compose.yml           mysql:8.4, redis:8
.gitignore
README.md                    запуск, кредити автора
shared/
  package.json  tsconfig.json
  src/index.ts
  src/age.ts                 вікові правила
  src/schemas/auth.ts        Zod: completeProfile, devLogin
  src/errors.ts              ErrorCode union
backend/
  .env.template  drizzle.config.ts  vitest.config.ts  Dockerfile
  src/config/env.ts          Zod-перевірка env
  src/app.ts                 createApp(deps)
  src/server.ts              запуск HTTP + Socket.IO
  src/db/client.ts           drizzle(mysql2 pool)
  src/db/schema/users.ts  auth.ts  events.ts  index.ts
  src/db/migrations/         генерує drizzle-kit
  src/redis/client.ts
  src/http/errors.ts         AppError, errorHandler
  src/http/security.ts       helmet, rate limit, csrf
  src/auth/session.service.ts
  src/auth/session.middleware.ts   loadSession, requireAuth, requireActive
  src/auth/identity.service.ts     resolveLogin, link, unlink, tombstones
  src/auth/providers/provider.ts   інтерфейс AuthProvider
  src/auth/providers/telegram.ts
  src/auth/providers/google.ts
  src/auth/dev-login.ts
  src/auth/auth.routes.ts
  src/users/users.service.ts       completeProfile, changeBirthDate, deleteAccount
  src/users/users.routes.ts
  src/events/events.service.ts     logEvent
  src/internal/internal.routes.ts  API для бота
  src/realtime/socket.ts
  src/cli/seed-owner.ts
  test/setup/global-setup.ts  test/helpers.ts
  test/**/*.test.ts
frontend/
  .env.template  proxy.conf.json  Dockerfile
  src/styles/themes/_tokens.less     змінні теми (LESS)
  src/styles/themes/dark.less
  src/styles/material-dark.scss      ЄДИНИЙ scss — генерація токенів Material
  src/styles.less
  src/assets/i18n/uk.json
  src/app/core/auth/auth.store.ts    signals
  src/app/core/auth/auth.api.ts
  src/app/core/realtime/socket.service.ts
  src/app/core/view-mode/view-mode.store.ts
  src/app/layout/shell/shell.{ts,html,less}
  src/app/features/auth/login/login.{ts,html,less}
  src/app/features/auth/complete-profile/complete-profile.{ts,html,less}
  src/app/features/account/account-settings/account-settings.{ts,html,less}
  src/app/features/about/about.{ts,html,less}
bot/
  .env.template  Dockerfile  vitest.config.ts
  src/config/env.ts
  src/api/backend-client.ts
  src/bot.ts                 /start <linkToken>
  src/i18n/uk.json
```

**Рішення щодо LESS і Material:** Angular Material 22 генерує токени теми лише через Sass API. Тому в проєкті рівно один файл `src/styles/material-dark.scss` (виклик `mat.theme()` з темною палітрою), а все інше — LESS. Нова тема = один `*.scss` з токенами Material + один `*.less` з власними змінними; компоненти використовують лише CSS-змінні (`var(--nri-…)`, `var(--mat-sys-…)`).

---

### Task 1: Каркас монорепо та локальна інфраструктура

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc`, `docker-compose.yml`, `README.md`
- Modify: `.gitignore` (додати `.angular/`, `*.log`, `backend/.env`, `frontend/.env`, `bot/.env`)

**Interfaces:**
- Produces: кореневі скрипти `npm run dev:db` (`docker compose up -d`), `npm run lint`, `npm test` (запускає тести всіх воркспейсів), `npm run typecheck`.

- [ ] **Step 1:** `package.json`: `"private": true`, `"workspaces": ["shared","backend","frontend","bot"]`, `"engines": {"node": ">=24"}`, devDependencies `typescript@~6.0`, `eslint`, `typescript-eslint`, `prettier`, `angular-eslint`.
- [ ] **Step 2:** `docker-compose.yml`: `mysql:8.4` (порт 3306, БД `nri` і `nri_test` через init-скрипт `docker/mysql-init.sql`, змінні з кореневого `.env`), `redis:8` (порт 6379), named volumes. Кореневий `.env.template` з `MYSQL_ROOT_PASSWORD`, `MYSQL_USER`, `MYSQL_PASSWORD` + пояснення.
- [ ] **Step 3:** `eslint.config.mjs`: правило `no-restricted-syntax` для файлів `frontend/src/**/*.ts`, що забороняє властивості `template` і `styles` у декораторі `@Component` (селектор `Decorator[expression.callee.name='Component'] Property[key.name=/^(template|styles)$/]`), повідомлення «Шаблони й стилі — лише в окремих .html/.less».
- [ ] **Step 4:** Перевірка правила: тимчасовий файл `frontend/src/lint-probe.ts` з `@Component({template: '<p></p>'})`, запуск `npx eslint frontend/src/lint-probe.ts` → очікувано 1 помилка; видалити файл.
- [ ] **Step 5:** `README.md`: назва «НРІ Асистент», опис, вимоги (Node 24, Docker), запуск (`npm i`, `npm run dev:db`, копіювати `.env.template` → `.env` у кожній частині, `npm run db:migrate -w backend`, `npm run dev -w backend|frontend|bot`), секція «Автор» з плейсхолдерами `<GITHUB_URL>`, `<EMAIL>`, `<TELEGRAM>`, `<LINKEDIN>` (заповнює власник).
- [ ] **Step 6:** `docker compose up -d` → `docker compose ps` показує обидва сервіси `healthy`/`running`.
- [ ] **Step 7: Commit** `chore: monorepo scaffold, lint rules, local mysql+redis`

---

### Task 2: Пакет `shared` — вікові правила, коди помилок, схеми

**Files:**
- Create: `shared/package.json` (name `@nri/shared`, `"type": "module"`, exports `./src/index.ts`), `shared/tsconfig.json`, `shared/src/{index,age,errors}.ts`, `shared/src/schemas/auth.ts`
- Test: `shared/src/age.test.ts`, `shared/src/schemas/auth.test.ts`

**Interfaces:**
- Produces:
  - `MIN_REGISTRATION_AGE = 14`, `BIRTH_DATE_CHANGE_COOLDOWN_DAYS = 30`
  - `type AgeRating = 'none' | '18+' | '21+'`
  - `ageOn(birthDate: string /* YYYY-MM-DD */, today: string /* YYYY-MM-DD */): number`
  - `canRegister(birthDate: string, today: string): boolean`
  - `meetsAgeRating(age: number | null, rating: AgeRating): boolean` — `null` (гість) проходить лише `'none'`
  - `type ErrorCode = 'VALIDATION' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CSRF' | 'RATE_LIMITED' | 'TELEGRAM_AUTH_INVALID' | 'OAUTH_STATE_INVALID' | 'IDENTITY_TAKEN' | 'IDENTITY_BANNED' | 'LAST_IDENTITY' | 'AGE_TOO_LOW' | 'BIRTH_DATE_COOLDOWN' | 'NICKNAME_TAKEN' | 'PROFILE_INCOMPLETE' | 'ACCOUNT_BANNED'`
  - `completeProfileSchema`: `{ nickname: string 3–32, /^[\p{L}\p{N}_.-]+$/u; birthDate: YYYY-MM-DD; timezone?: IANA string }`
  - `devLoginSchema`: `{ nickname: string; ownerKey?: string }`

- [ ] **Step 1: Write the failing tests** (`age.test.ts`)

```ts
it('exactly 14 today is allowed', () => expect(canRegister('2012-11-24', '2026-11-24')).toBe(true));
it('one day short of 14 is refused', () => expect(canRegister('2012-11-25', '2026-11-24')).toBe(false));
it('leap-day birthday counts on Feb 28 in non-leap year', () => expect(ageOn('2008-02-29', '2026-02-28')).toBe(17));
it('guest sees only unrated games', () => {
  expect(meetsAgeRating(null, 'none')).toBe(true);
  expect(meetsAgeRating(null, '18+')).toBe(false);
});
it('20-year-old: 18+ yes, 21+ no', () => {
  expect(meetsAgeRating(20, '18+')).toBe(true);
  expect(meetsAgeRating(20, '21+')).toBe(false);
});
```
`auth.test.ts`: `completeProfileSchema` відхиляє нік `'ab'`, нік з пробілом, дату `'2026-13-01'`; приймає `{nickname:'Майстер_Ігор', birthDate:'2000-01-01'}`.

- [ ] **Step 2:** `npm test -w shared` → FAIL (модулі не існують).
- [ ] **Step 3:** Реалізувати `age.ts`, `errors.ts`, `schemas/auth.ts`, реекспорт в `index.ts`. Дати — рядки `YYYY-MM-DD`, обчислення без `Date`-часових поясів (порівняння рік/місяць/день; 29 лютого в невисокосний рік вважається 28 лютого — так, як очікує тест).
- [ ] **Step 4:** `npm test -w shared` → PASS.
- [ ] **Step 5: Commit** `feat(shared): age rules, error codes, auth schemas`

---

### Task 3: Бекенд-каркас — env, app, помилки, безпека

**Files:**
- Create: `backend/package.json` (`@nri/backend`, скрипти `dev` = `tsx watch src/server.ts`, `test`, `db:generate`, `db:migrate`, `seed:owner`), `backend/tsconfig.json`, `backend/vitest.config.ts`, `backend/.env.template`, `backend/src/config/env.ts`, `backend/src/app.ts`, `backend/src/server.ts`, `backend/src/http/errors.ts`, `backend/src/http/security.ts`, `backend/src/redis/client.ts`
- Test: `backend/test/http/app.test.ts`

**Interfaces:**
- Produces:
  - `loadEnv(source = process.env): Env` — кидає помилку з переліком відсутніх ключів
  - `class AppError extends Error { constructor(status: number, code: ErrorCode, details?: unknown) }`
  - `errorHandler` → відповідь `{ error: { code, details? } }`; ZodError → 400 `VALIDATION`; невідоме → 500 без стеку
  - `createApp(deps: AppDeps): express.Express`, де `AppDeps = { env: Env; db: Db; redis: Redis }`
  - `csrfProtection` — видає `nri_csrf` на будь-якому GET, перевіряє `X-CSRF-Token === cookie` на POST/PUT/PATCH/DELETE, крім `/api/internal/*` (там ключ)
  - `GET /api/health` → `{ ok: true }`

- [ ] **Step 1:** `.env.template` з ключами та коментарями «що/де взяти»: `NODE_ENV`, `PORT`, `PUBLIC_BASE_URL` (публічний URL фронту, для OAuth callback і OG; локально `http://localhost:4200`), `DATABASE_URL`, `DATABASE_URL_TEST`, `REDIS_URL`, `SESSION_TTL_DAYS=30`, `IDENTITY_PEPPER` (32+ випадкові байти, `openssl rand -base64 32`), `TELEGRAM_BOT_TOKEN` (BotFather → /newbot), `TELEGRAM_BOT_USERNAME`, `TELEGRAM_LOGIN_MAX_AGE_SEC=86400`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (Google Cloud Console → APIs & Services → Credentials → OAuth client ID, тип Web, redirect `${PUBLIC_BASE_URL}/api/auth/google/callback`), `INTERNAL_API_KEY` (спільний з ботом), `DEV_LOGIN_ENABLED`, `DEV_OWNER_KEY`, `TRUST_PROXY` (кількість проксі перед сервером у prod).
- [ ] **Step 2: Write the failing tests** (`app.test.ts`, supertest на `createApp` з тестовими deps)
  - `GET /api/health` → 200 `{ok:true}`, у відповіді є `Set-Cookie: nri_csrf=…`
  - `POST /api/health-echo` (тестовий маршрут лише в `NODE_ENV=test`) без `X-CSRF-Token` → 403 `{error:{code:'CSRF'}}`; з правильним заголовком і кукою → 200
  - маршрут, що кидає `new AppError(409,'NICKNAME_TAKEN')` → 409 `{error:{code:'NICKNAME_TAKEN'}}`
  - відповідь має заголовки helmet (`x-content-type-options: nosniff`)
  - `loadEnv({})` кидає помилку, що містить `DATABASE_URL`
- [ ] **Step 3:** `npm test -w backend -- app` → FAIL.
- [ ] **Step 4:** Реалізувати. `helmet()`, `cookie-parser`, `express.json({limit:'100kb'})`, `express-rate-limit` з `rate-limit-redis` (загальний ліміт 300 запитів/5 хв на IP; для `/api/auth/*` — 20/5 хв), `app.set('trust proxy', env.TRUST_PROXY)`.
- [ ] **Step 5:** `npm test -w backend -- app` → PASS.
- [ ] **Step 6: Commit** `feat(backend): app skeleton, env validation, errors, csrf, rate limit`

---

### Task 4: Схема БД — користувачі, ідентичності, сесії, «надгробки», події

**Files:**
- Create: `backend/drizzle.config.ts`, `backend/src/db/client.ts`, `backend/src/db/schema/{users,auth,events,index}.ts`, `backend/src/events/events.service.ts`, `backend/test/setup/global-setup.ts`, `backend/test/helpers.ts`
- Generate: `backend/src/db/migrations/0000_*.sql`
- Test: `backend/test/db/schema.test.ts`, `backend/test/events/events.test.ts`

**Interfaces:**
- Produces (таблиці, snake_case у БД, camelCase у TS):
  - `users`: `id` bigint unsigned PK auto, `nickname` varchar(32) unique **null** (null поки профіль не завершено), `avatarUrl` varchar(512) null, `birthDate` date null, `birthDateChangedAt` datetime null, `role` enum(`owner`,`admin`,`moderator`,`user`) default `user`, `status` enum(`pending`,`active`,`deleted`) default `pending`, `isBanned` bool default false, `timezone` varchar(64) default `Europe/Kyiv`, `locale` varchar(8) default `uk`, `privacy` json default `{}`, `createdAt`, `updatedAt`, `deletedAt` null
  - `auth_identities`: `id`, `userId` FK→users cascade, `provider` enum(`telegram`,`google`,`discord`,`dev`), `subject` varchar(191), `displayName` varchar(191) null, `createdAt`; unique(`provider`,`subject`)
  - `sessions`: `id`, `userId` FK cascade, `tokenHash` char(64) unique, `createdAt`, `lastSeenAt`, `expiresAt`, `userAgent` varchar(255) null, `ip` varchar(45) null; index(`userId`)
  - `identity_tombstones`: `id`, `provider`, `subjectHash` char(64), `isBanned` bool, `createdAt`; unique(`provider`,`subjectHash`)
  - `events`: `id`, `type` varchar(64), `userId` bigint null, `entityType` varchar(32) null, `entityId` bigint null, `payload` json null, `createdAt`; index(`type`,`createdAt`)
  - `type Db = MySql2Database<typeof schema>`; `createDb(url: string): { db: Db; pool: Pool }` (mysql2 pool з `timezone: 'Z'`, `dateStrings` для `date`-колонок)
  - `logEvent(db: Db, e: { type: string; userId?: number; entityType?: string; entityId?: number; payload?: unknown }): Promise<void>` — ніколи не кидає (помилку логуємо)
  - test helpers: `testDeps(): Promise<AppDeps>` (БД `nri_test`, Redis db 15), `resetDb(db)` (TRUNCATE усіх таблиць), `createUser(db, overrides?)`
- [ ] **Step 1: Write the failing tests**: `schema.test.ts` — вставка двох `auth_identities` з однаковими (`provider`,`subject`) кидає помилку дубля; видалення користувача каскадно видаляє його сесії. `events.test.ts` — `logEvent` записує рядок з payload `{a:1}`, що читається як об'єкт.
- [ ] **Step 2:** `npm test -w backend -- db events` → FAIL.
- [ ] **Step 3:** Описати схему, `npm run db:generate -w backend`, `global-setup.ts` застосовує міграції до `DATABASE_URL_TEST` через `migrate()` з drizzle.
- [ ] **Step 4:** `npm run db:migrate -w backend` проти `nri` → без помилок; `npm test -w backend -- db events` → PASS.
- [ ] **Step 5: Commit** `feat(backend): core db schema, migrations, event log`

---

### Task 5: Сесії — створення, кеш у Redis, middleware, вихід

**Files:**
- Create: `backend/src/auth/session.service.ts`, `backend/src/auth/session.middleware.ts`, `backend/src/users/users.service.ts` (поки лише `banUser(deps, userId): Promise<void>`)
- Test: `backend/test/auth/session.test.ts`

**Interfaces:**
- Consumes: `Db`, `Redis`, `Env`
- Produces:
  - `createSession(deps, userId: number, meta: {userAgent?: string; ip?: string}): Promise<{ token: string; expiresAt: Date }>`
  - `resolveSession(deps, token: string): Promise<SessionUser | null>` — Redis-ключ `sess:<tokenHash>` (TTL 5 хв) → інакше БД; оновлює `lastSeenAt`/`expiresAt` не частіше ніж раз на 10 хв
  - `type SessionUser = { sessionId: number; userId: number; role: Role; status: UserStatus; isBanned: boolean; birthDate: string | null }`
  - `revokeSession(deps, token)`, `revokeAllUserSessions(deps, userId)` — видаляє рядки БД **і** ключі Redis (Redis-сет `usess:<userId>` з хешами)
  - `setSessionCookie(res, token, expiresAt, env)`, `clearSessionCookie(res)`
  - middleware: `loadSession(deps)` → `req.user?: SessionUser`; `requireAuth` → 401 `UNAUTHENTICATED`; забанений → 403 `ACCOUNT_BANNED` + `revokeAllUserSessions`; `requireActive` → 403 `PROFILE_INCOMPLETE` якщо `status='pending'`
  - `POST /api/auth/logout`, `POST /api/auth/logout-all`
- [ ] **Step 1: Write the failing tests**
  - `createSession` → у БД `tokenHash === sha256hex(token)`, сирого токена в БД немає
  - запит з кукою `nri_sid` на тестовий маршрут з `requireAuth` → 200; без куки → 401
  - **(Review Focus 4)** після `UPDATE users SET is_banned=1` і **без** очищення кешу вручну, наступний запит → 403 `ACCOUNT_BANNED`; ще один → 401 (сесії відкликано). Для цього бан у тестах і в адмінці (План 5) іде через `banUser(deps, userId)`, яка ставить прапорець і викликає `revokeAllUserSessions` — додати `banUser` у `users.service.ts` зараз і тестувати через неї
  - протермінована сесія (`expiresAt` у минулому) → 401
  - `logout-all` з двома сесіями → обидві недійсні
- [ ] **Step 2:** FAIL. **Step 3:** реалізувати. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(backend): server-side sessions with redis cache`

---

### Task 6: Ідентичності та вхід через Telegram

**Files:**
- Create: `backend/src/auth/providers/provider.ts`, `backend/src/auth/providers/telegram.ts`, `backend/src/auth/identity.service.ts`, `backend/src/auth/auth.routes.ts`
- Test: `backend/test/auth/telegram.test.ts`, `backend/test/auth/identity.test.ts`

**Interfaces:**
- Produces:
  - `interface VerifiedIdentity { provider: Provider; subject: string; displayName?: string; avatarUrl?: string }`
  - `verifyTelegramLogin(data: Record<string,string>, botToken: string, maxAgeSec: number, nowSec: number): VerifiedIdentity` — кидає `AppError(401,'TELEGRAM_AUTH_INVALID')`
  - `subjectHash(provider, subject, pepper): string` — HMAC-SHA256 hex
  - `resolveLogin(deps, identity): Promise<{ userId: number; isNew: boolean }>` — існує ідентичність → її користувач; нема → перевірка `identity_tombstones` (забанений → 403 `IDENTITY_BANNED`) → створити `users(status='pending', avatarUrl)` + `auth_identities`; `logEvent('user.registered')`
  - `linkIdentity(deps, userId, identity)` — належить іншому → 409 `IDENTITY_TAKEN`; вже моя → no-op; tombstone забанений → 403 `IDENTITY_BANNED`
  - `POST /api/auth/telegram` `{...widget fields}` → створює сесію, `{ user: MeDto }`; `POST /api/auth/telegram/link` (requireAuth) → `{ identities }`
- [ ] **Step 1: Write the failing tests**
  - `telegram.test.ts`: валідні дані, підписані тестовим токеном (алгоритм: `secret = sha256(botToken)`; `data_check_string` = відсортовані `key=value` усіх полів крім `hash`, через `\n`; `hash = hmacSha256Hex(secret, data_check_string)`) → повертає `{provider:'telegram', subject:'<id>'}`
  - **(Review Focus 1)** змінене поле `first_name` → кидає `TELEGRAM_AUTH_INVALID`; `auth_date = now - 86401` → кидає
  - `identity.test.ts`: перший вхід створює `pending`-користувача; другий вхід тим самим `subject` → той самий `userId`, `isNew=false`; `linkIdentity` чужої ідентичності → 409 `IDENTITY_TAKEN`; існує banned-tombstone для `subjectHash` → `resolveLogin` кидає `IDENTITY_BANNED`
  - маршрут `POST /api/auth/telegram` з валідними даними → 200 і `Set-Cookie: nri_sid`
- [ ] **Step 2:** FAIL. **Step 3:** реалізувати (`crypto.timingSafeEqual` для порівняння хешу). **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(backend): identities and telegram login`

---

### Task 7: Вхід через Google (OAuth + PKCE) і модульні провайдери

**Files:**
- Create: `backend/src/auth/providers/google.ts`
- Modify: `backend/src/auth/auth.routes.ts`
- Test: `backend/test/auth/google.test.ts`

**Interfaces:**
- Consumes: `resolveLogin`, `linkIdentity`, `createSession`
- Produces:
  - `interface OAuthProvider { id: 'google' | 'discord'; createAuthorizationUrl(state: string, codeVerifier: string): URL; exchange(code: string, codeVerifier: string): Promise<VerifiedIdentity> }` (Discord у Плані 5 реалізує той самий інтерфейс)
  - `GET /api/auth/:provider/start?mode=login|link&returnTo=/path` — зберігає `{state, codeVerifier, mode, userId?, returnTo}` у Redis `oauth:<state>` TTL 10 хв, редірект на провайдера. `returnTo` — лише відносний шлях, що починається з `/` і не з `//`
  - `GET /api/auth/:provider/callback?code&state` — state відсутній/прострочений → редірект на `/login?error=OAUTH_STATE_INVALID`; успіх → сесія, редірект на `returnTo` (або `/complete-profile`, якщо `pending`)
- [ ] **Step 1: Write the failing tests** (провайдер замокано через DI — `createApp` приймає `oauthProviders: Record<string, OAuthProvider>`)
  - `start` → 302 на URL провайдера, у Redis є `oauth:<state>`
  - `callback` з невідомим `state` → 302 на `/login?error=OAUTH_STATE_INVALID`
  - `callback` з валідним state → 302, `Set-Cookie: nri_sid`, ключ `oauth:<state>` видалено (одноразовий)
  - `start?returnTo=//evil.com` → `returnTo` замінено на `/`
  - `mode=link` для залогіненого користувача додає ідентичність до нього, а не створює нового
- [ ] **Step 2:** FAIL. **Step 3:** реалізувати через `arctic` (`Google`, `generateState`, `generateCodeVerifier`); профіль з `id_token` (`sub`, `name`, `picture`). **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(backend): google oauth with pkce, pluggable oauth providers`

---

### Task 8: Dev-вхід

**Files:**
- Create: `backend/src/auth/dev-login.ts`
- Modify: `backend/src/app.ts` (монтувати лише якщо умови env виконані)
- Test: `backend/test/auth/dev-login.test.ts`

**Interfaces:**
- Produces: `POST /api/auth/dev-login` `{nickname, ownerKey?}` → вхід/створення dev-користувача (ідентичність `provider='dev'`, `subject=nickname`, одразу `status='active'`, `birthDate='2000-01-01'`). Якщо `nickname` належить користувачу з `role='owner'` — потрібен `ownerKey === DEV_OWNER_KEY`, інакше 403 `FORBIDDEN`. Якщо `DEV_OWNER_KEY` порожній — вхід у власника неможливий взагалі.
- [ ] **Step 1: Write the failing tests**
  - з `127.0.0.1`, `NODE_ENV=development`, `DEV_LOGIN_ENABLED=true` → 200 + кука
  - **(Review Focus 2)** `NODE_ENV=production` → 404; `DEV_LOGIN_ENABLED=false` → 404; не-локальна `remoteAddress` (у тесті підмінити через `app.request.socket` або слухати на зовнішньому інтерфейсі; простіше — винести перевірку в `isLocalRequest(req)` і тестувати юнітом з об'єктом `{socket:{remoteAddress:'10.0.0.5'}, headers:{'x-forwarded-for':'127.0.0.1'}}` → `false`)
  - вхід у власника без ключа → 403; з неправильним → 403; з правильним → 200
- [ ] **Step 2:** FAIL. **Step 3:** реалізувати. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(backend): localhost-only dev login with owner key`

---

### Task 9: Профіль-мінімум, прив'язки, видалення акаунта, власник

**Files:**
- Create: `backend/src/users/users.service.ts` (доповнити `banUser` з Task 5), `backend/src/users/users.routes.ts`, `backend/src/cli/seed-owner.ts`
- Test: `backend/test/users/users.test.ts`, `backend/test/cli/seed-owner.test.ts`

**Interfaces:**
- Produces:
  - `type MeDto = { id; nickname: string | null; avatarUrl; birthDate; role; status; timezone; locale; identities: { provider; displayName }[] }`
  - `GET /api/me` (requireAuth) → `MeDto`
  - `POST /api/me/complete-profile` `completeProfileSchema` — вік < 14 → 422 `AGE_TOO_LOW` **і** pending-користувач з його ідентичностями та сесіями видаляється (реєстрацію відхилено, tombstone не створюється); нік зайнятий → 409 `NICKNAME_TAKEN`; успіх → `status='active'`, `logEvent('user.activated')`
  - `PATCH /api/me/birth-date` `{birthDate}` (requireActive) — якщо `birthDateChangedAt` < 30 днів тому → 409 `BIRTH_DATE_COOLDOWN` з `details.availableAt`; нова дата з віком < 14 → 422 `AGE_TOO_LOW`
  - `DELETE /api/me/identities/:provider` → якщо це остання ідентичність → 409 `LAST_IDENTITY`
  - `DELETE /api/me` → `deleteAccount(deps, userId)`: `status='deleted'`, `nickname=null`, `avatarUrl=null`, `birthDate=null`, `deletedAt=now`; для кожної ідентичності — tombstone (`isBanned = users.isBanned`), ідентичності видаляються; `revokeAllUserSessions`; `logEvent('user.deleted')`. Відображення «Видалений користувач» — на фронті за `status='deleted'`
  - CLI `npm run seed:owner -w backend -- --nickname <nick>`: робить існуючого активного користувача `role='owner'`; якщо власник уже є — помилка «owner already exists»
- [ ] **Step 1: Write the failing tests**
  - complete-profile з датою 13 років → 422 `AGE_TOO_LOW`, рядка користувача більше нема
  - complete-profile з чужим ніком → 409 `NICKNAME_TAKEN`
  - дві зміни дати народження поспіль → друга 409 `BIRTH_DATE_COOLDOWN`
  - **(Review Focus 5)** відв'язати єдину ідентичність → 409 `LAST_IDENTITY`; з двома — 200
  - видалення забаненого користувача → tombstone `isBanned=true`; повторний `resolveLogin` тією ж ідентичністю → `IDENTITY_BANNED`; видалення незабаненого → повторний вхід створює **нового** pending-користувача
  - `seed-owner` двічі → друга спроба кидає помилку
- [ ] **Step 2:** FAIL. **Step 3:** реалізувати (усі мутації в транзакціях). **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(backend): profile completion, identity unlink, account deletion, owner seed`

---

### Task 10: Socket.IO з автентифікацією кукою

**Files:**
- Create: `backend/src/realtime/socket.ts`
- Modify: `backend/src/server.ts`
- Test: `backend/test/realtime/socket.test.ts`

**Interfaces:**
- Produces:
  - `attachRealtime(httpServer, deps): RealtimeHub`; `interface RealtimeHub { toUser(userId: number, event: string, payload: unknown): void; toRoom(room: string, event: string, payload: unknown): void }`
  - handshake: читає `nri_sid` з cookie-заголовка → `resolveSession`; нема/бан → `next(new Error('UNAUTHENTICATED'))`. Підключений сокет автоматично в кімнаті `user:<id>`. Інші кімнати (План 4) — лише через серверну перевірку прав.
  - адаптер `@socket.io/redis-adapter`
- [ ] **Step 1: Write the failing tests** (`socket.io-client`): без куки → `connect_error` з `UNAUTHENTICATED`; з кукою → підключено, `hub.toUser(id,'ping',{x:1})` доходить до клієнта.
- [ ] **Step 2:** FAIL. **Step 3:** реалізувати. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(backend): authenticated socket.io with user rooms`

---

### Task 11: Внутрішній API та Telegram-бот (каркас і прив'язка)

**Files:**
- Create: `backend/src/internal/internal.routes.ts`, `bot/package.json` (`@nri/bot`), `bot/tsconfig.json`, `bot/vitest.config.ts`, `bot/.env.template`, `bot/src/config/env.ts`, `bot/src/api/backend-client.ts`, `bot/src/bot.ts`, `bot/src/i18n/uk.json`, `bot/Dockerfile`
- Modify: `backend/src/users/users.routes.ts`
- Test: `backend/test/internal/internal.test.ts`, `bot/src/bot.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/me/telegram-link-token` (requireActive) → `{ url: 'https://t.me/<TELEGRAM_BOT_USERNAME>?start=<token>' }`; токен 16 байт base64url у Redis `tglink:<token>` → userId, TTL 10 хв
  - `POST /api/internal/telegram/link` з заголовком `X-Internal-Key: <INTERNAL_API_KEY>` (`timingSafeEqual`), тіло `{ token, telegramId, displayName }` → `linkIdentity` (ті самі помилки) і `{ ok: true, nickname }`; токен одноразовий
  - невірний/відсутній ключ → 401
  - бот: `/start <token>` → виклик `backendClient.linkTelegram(token, from.id, from.username ?? from.first_name)` → повідомлення з `uk.json` (`link.success` з ніком / `link.taken` / `link.expired`); `/start` без токена → `start.welcome`
  - `bot/.env.template`: `TELEGRAM_BOT_TOKEN`, `BACKEND_INTERNAL_URL` (напр. `http://localhost:3000/api/internal`), `INTERNAL_API_KEY` — з поясненнями
- [ ] **Step 1: Write the failing tests**: бекенд — без ключа 401; валідний токен прив'язує ідентичність; повторне використання токена → 404 `NOT_FOUND`. Бот — обробник `/start abc` з замоканим `backendClient` відповідає текстом `link.success`; при `IDENTITY_TAKEN` — `link.taken`.
- [ ] **Step 2:** FAIL. **Step 3:** реалізувати (обробники в `bot.ts` як чисті функції `handleStart(ctx, client, t)` для тестування; запуск через long polling). **Step 4:** PASS.
- [ ] **Step 5:** Ручна перевірка: `npm run dev -w bot` з реальним токеном → `/start` у Telegram відповідає привітанням.
- [ ] **Step 6: Commit** `feat(bot): bot scaffold, internal api, telegram account linking`

---

### Task 12: Фронтенд-оболонка — тема, i18n, стан автентифікації, вхід

**Files:**
- Create: `frontend/` через `npx @angular/cli@22 new frontend --style=less --ssr=false --routing --skip-git` (у корені репо), далі файли зі структури вище; `frontend/proxy.conf.json` (`/api` і `/socket.io` → `http://localhost:3000`, `ws: true`); `frontend/.env.template` (`NG_APP_TELEGRAM_BOT_USERNAME`, `NG_APP_DEV_LOGIN` — пояснення: лише для dev, не секрет); `frontend/Dockerfile` (build → nginx зі статикою)
- Test: `frontend/src/app/core/auth/auth.store.spec.ts`, `frontend/src/app/features/auth/complete-profile/complete-profile.spec.ts`, `frontend/src/app/core/view-mode/view-mode.store.spec.ts`

**Interfaces:**
- Consumes: `/api/me`, `/api/auth/*`, `/api/me/*` (Tasks 5–9), `@nri/shared` (`completeProfileSchema`, `canRegister`, `ErrorCode`)
- Produces:
  - `AuthStore` (signals): `me: Signal<MeDto | null>`, `isAuthenticated: Signal<boolean>`, `isPending: Signal<boolean>`, `load(): Promise<void>`, `logout(): Promise<void>`
  - guards: `authGuard`, `activeGuard` (pending → `/complete-profile`), `guestGuard`
  - `ViewModeStore`: `mode: Signal<'player' | 'gm'>`, `setMode(m)`; зберігає в `localStorage` (у try/catch), за замовчуванням `'player'`
  - `SocketService`: `connect()` після входу, `on<T>(event): Observable<T>`, `disconnect()` при виході
  - маршрути: `/login`, `/complete-profile`, `/account`, `/about`, `/` (порожня головна-заглушка для Плану 2)
  - `provideHttpClient(withXsrfConfiguration({ cookieName: 'nri_csrf', headerName: 'X-CSRF-Token' }))`
  - перекладач `@ngx-translate/core` з `assets/i18n/uk.json`, мова за замовчуванням `uk`
- [ ] **Step 0:** Дизайн-система через проєктний скіл `ui-ux-pro-max` (`.claude/skills/ui-ux-pro-max`): `python .claude/skills/ui-ux-pro-max/scripts/search.py "tabletop rpg community game finder dark" --design-system --persist -p "NRI Assistant" --output-dir .` → `design-system/nri-assistant/MASTER.md`. Палітру й шрифти з MASTER.md узгодити з власником, потім перенести в токени нижче (замість дефолтних `violet/orange`, якщо власник обере інше). Перед здачею UI — чекліст із `references/quick-reference.md` (контраст 4.5:1 у темній темі, фокус, підписи полів).
- [ ] **Step 1:** Тема: `material-dark.scss` — `html { color-scheme: dark; @include mat.theme((color: (theme-type: dark, primary: mat.$violet-palette, tertiary: mat.$orange-palette), typography: Roboto, density: 0)); }`. `themes/_tokens.less` — власні змінні (`--nri-surface-raised`, `--nri-new-highlight`, `--nri-blur-overlay` тощо), `dark.less` — їх значення під `:root[data-theme='dark']`. `index.html` має `data-theme="dark"` на `<html>`. В `angular.json` styles: `["src/styles/material-dark.scss", "src/styles.less"]`.
- [ ] **Step 2: Write the failing tests**
  - `AuthStore.load()` з відповіддю `/api/me` 401 → `me()===null`, `isAuthenticated()===false`; з `status:'pending'` → `isPending()===true`
  - `CompleteProfile`: дата народження 13 років → кнопка «Зберегти» вимкнена й показано ключ `profile.errors.AGE_TOO_LOW`; відповідь 409 `NICKNAME_TAKEN` → показано `profile.errors.NICKNAME_TAKEN`
  - `ViewModeStore`: `setMode('gm')` → `mode()==='gm'`; якщо `localStorage` кидає — працює з дефолтом без помилки
- [ ] **Step 3:** `npm test -w frontend` → FAIL.
- [ ] **Step 4:** Реалізувати компоненти (кожен: `.ts` + `.html` + `.less`):
  - `Shell` — Material toolbar з назвою «НРІ Асистент», перемикач «Вид гравця / Вид майстра» (видно лише залогіненим активним), меню акаунта, футер з посиланням на «Про проєкт»
  - `Login` — віджет Telegram Login (скрипт `https://telegram.org/js/telegram-widget.js?22` з `data-onauth`, що викликає `POST /api/auth/telegram`), кнопка Google (`/api/auth/google/start?mode=login`), форма dev-входу лише якщо `NG_APP_DEV_LOGIN==='true'`; помилки з `?error=` перекладаються
  - `CompleteProfile` — нік, дата народження (Material datepicker), часовий пояс (дефолт з `Intl.DateTimeFormat().resolvedOptions().timeZone`), попередження про мінімальний вік 14
  - `AccountSettings` — список прив'язаних способів входу, «Прив'язати Telegram» (відкриває `url` з `/api/me/telegram-link-token`), «Прив'язати Google», «Відв'язати», зміна дати народження (з показом `availableAt` при cooldown), «Вийти на всіх пристроях», «Видалити акаунт» (Material dialog з підтвердженням)
  - `About` — опис проєкту і кредити автора (плейсхолдери, як у README)
- [ ] **Step 5:** `npm test -w frontend` → PASS; `npm run lint` → без помилок (включно з правилом про inline-шаблони).
- [ ] **Step 6:** Ручна перевірка в браузері: `npm run dev -w backend` + `npm run dev -w frontend` → `/login` → dev-вхід → `/complete-profile` не показується (dev-користувач активний) → `/account` показує ідентичність `dev`; DevTools → WS-з'єднання `/socket.io` встановлене.
- [ ] **Step 7: Commit** `feat(frontend): app shell, dark theme, i18n, auth flows, account settings`

---

### Task 13: Dockerfile-и та фінальна перевірка

**Files:**
- Create: `backend/Dockerfile`, `.dockerignore`
- Modify: `README.md` (секція «Розгортання»: збірка образів, змінні середовища, `TRUST_PROXY`, reverse proxy з `/api` і `/socket.io` на бекенд, решта — на фронт; домен у BotFather `/setdomain` для Telegram Login; Google redirect URI)

- [ ] **Step 1:** Multi-stage Dockerfile-и (build → runtime `node:24-alpine`, non-root user); `docker build -f backend/Dockerfile .` і так само для `bot`, `frontend` → успішно.
- [ ] **Step 2:** `npm run lint && npm run typecheck && npm test` з кореня → все зелене.
- [ ] **Step 3:** `git grep -nE "(TOKEN|SECRET|KEY|PASSWORD)=.+" -- ':!*.template'` → порожньо (жодного секрету в репо).
- [ ] **Step 4: Commit** `chore: dockerfiles, deployment notes`
