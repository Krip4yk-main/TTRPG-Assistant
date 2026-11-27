# План 15 — приблизний час, чернетки без дати, аватари, dev-середовище, бекапи

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** виконати побажання власника від 2026-11-27 (після Плану 13).

**Architecture:** monorepo `shared` (zod-контракти) → `backend` (Express 5 + Drizzle/MySQL + Redis, міграції drizzle-kit) → `frontend` (Angular 22 zoneless, Material, i18n `uk.json`) → `bot` (grammY).

**Spec:** рішення власника в чаті 2026-11-27 (переписано нижче як Global Constraints). Окремого spec-файлу немає — рішення нижче є авторитетом.

## Global Constraints

- Мова інтерфейсу й коментарів — українська; тексти лише через `frontend/src/assets/i18n/uk.json` (+ `bot/src/i18n/uk.json`).
- Нові міграції — наступні номери після `0044` (`backend/src/db/migrations`), генерувати `npm run db:generate -w backend` (drizzle-kit), не писати SQL вручну без snapshot.
- Тести: backend — `npm test -w backend` (НІКОЛИ два процеси backend-тестів одночасно); shared/frontend/bot — `npm test -w <ws>`; typecheck — `npm run typecheck`. Prettier лише на змінених файлах.
- Не друкувати й не комітити секрети/`.env`. Не змінювати ролі користувачів dev-БД.
- Коміти закінчуються `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Кулдаун після відхилення заявки — **1 година** (`APPLICATION_REJECT_COOLDOWN_MS`), після відкликання — як було, 10 хв.
- Бекап — раз на добу (як зараз, 03:30 UTC). Ротація: **щоденні — 30 днів**, далі **одна копія на місяць** (копія 1-го числа місяця), місячні зберігаються **12 місяців**. Те саме правило — локально й на віддаленому сховищі (R2/B2).
- Середовища: `local` (машина розробника, не рахується), **`dev`** (окремий сервер, тестування сторонніх сервісів: Telegram-бот, OAuth, iCal) і **`prod`**. Dev — окремий сервер, свої БД/Redis/бот/OAuth-застосунки/домен.
- Порожня дата старту (`startsAt = null`) дозволена **лише для чернетки**; перехід у набір (`recruiting`) без дати — 422 `GAME_START_REQUIRED`. Копія гри (`cloneGame`) тепер створюється з `startsAt = null`.
- Приблизний час: майстер може задати не точний час, а **вікно початку «з N до M»** (у день сесії) — і для дати старту гри (правило розкладу), і для будь-якої окремої сесії (ручної / перенесеної). Вікно = `startsAt` (N, початок вікна) + `startWindowMinutes` (M−N; 30..720, крок 30); `null` = точний час.
- **Почати гру** (`recruiting → started`) неможливо, поки найближча запланована сесія має вікно — 409 `SESSION_TIME_APPROXIMATE`. Завершити (`finish`) сесію з вікном теж не можна — та сама помилка; майстер спершу «уточнює час».
- Аватар: джерела — Google, Discord, **Telegram** (`photo_url` з Telegram-входу) або **власне посилання** (перевірка через наявний `backend/src/http/image-url.ts`, ліміт `imageCheck`), або без аватара. Користувач обирає джерело в профілі.
- Тихі години й заборона копіювати чужі ігри **вже реалізовані** (Plan 13) — не переробляти.

## Review Focus

- Чернетка з `startsAt = null`: кожен споживач `startsAt` гри (пошук, картки, ICS, дедлайни, «мертві» ігри, нагадування, матеріалізація) мусить не падати на `null`.
- Вікно часу через перехід на літній час: `startsAt + startWindowMinutes` рахувати в UTC-мілісекундах, не в локальних годинах.
- Перенесення сесії з вікном на точний час (і навпаки) — сповіщення учасникам кажуть правильний час/вікно.
- Нагадування учасникам (`session.reminder`) для сесії з вікном — від початку вікна.
- Власне посилання на аватар, що перестало відкриватись, — показується заглушка (вже є fallback на фронті).

---

### Task 1: Кулдаун 1 год і чистка виконаних джобів

**Files:** `shared/src/contracts/applications.ts`, тести кулдауну (`backend/test/applications/applications-hardening.test.ts`, `shared/src/contracts/applications.test.ts`), `backend/src/jobs/daily.ts` (+ тест), можливо `backend/src/jobs/queue.ts`.

- [ ] `APPLICATION_REJECT_COOLDOWN_MS = HOUR` (60 хв); оновити тести й тексти, де згадано «24 год/добу».
- [ ] Таблиця `jobs` росте ~7 тис. рядків `done` на добу (найбільша таблиця dev-БД). Додати в щоденну чистку `purgeDoneJobs(deps, now)`: видаляти `status='done'` старші за **3 доби** батчами по 5000 (як інші purge-функції в `daily.ts`). `failed`/`pending` не чіпати. Тест: старий done видалено, свіжий done і старий failed — лишились.
- [ ] Коміт.

### Task 2: Ротація бекапів 30 щоденних + 12 місячних

**Files:** `scripts/ops/backup.sh`, `scripts/ops/backup-lib.sh` (якщо треба), `docs/ops/backups.md`.

- [ ] Локально: `$BACKUP_DIR` — щоденні, `KEEP_DAILY=30`; замість `weekly/` — `monthly/`: якщо дата бекапу 1-ше число місяця **або** в `monthly/` ще немає копії за поточний місяць — копія туди; `KEEP_MONTHLY=12`. Стару папку `weekly/` скрипт лише лишає (не видаляє вручну створене), але нові туди не пише; у доках — що її можна видалити.
- [ ] Віддалено (rclone): `$REMOTE/daily/` — `--min-age 30d` видаляє; `$REMOTE/monthly/` — та сама логіка «перша копія місяця», видалення `--min-age 365d`. Старі файли в корені `$REMOTE` (з Плану 13) видаляти правилом 30d, як було.
- [ ] Перевірка відновлення (`restore-check.sh`) бере найсвіжіший щоденний — переконатись, що шлях не зламався.
- [ ] Перевірити скрипт `sh -n` і, якщо доступний Docker, прогоном з тимчасовою папкою (без справжніх секретів). Оновити `docs/ops/backups.md` (розклад, обсяг: зараз дамп ≈3.8 МБ, gzip ≈0.4 МБ).
- [ ] Коміт.

### Task 3: Dev-середовище на окремому сервері

**Files:** `docker-compose.prod.yml` (лише параметризація, якщо потрібно), створити `.env.dev.template` і `.env.prod.template` (або один шаблон з поясненням), `backend/src/config/env.ts`, `frontend` (банер), `docs/ops/environments.md`, `docs/ops/deploy.md`.

- [ ] Змінна `DEPLOY_ENV` = `local | dev | prod` (дефолт `local`). Валідація в `env.ts`. У `dev` і `prod` — ті самі вимоги, що зараз для production (https `PUBLIC_BASE_URL`, секрети).
- [ ] Dev на окремому сервері використовує той самий `docker-compose.prod.yml` з іншим env-файлом (`docker compose --env-file .env.dev -f docker-compose.prod.yml up -d`); бекапи на dev вимкнено за замовчуванням (`BACKUP_ENABLED=false` → сервіс бекапу спить/виходить чисто, без помилок у лозі).
- [ ] На dev: заголовок `X-Robots-Tag: noindex, nofollow` для всіх відповідей і `robots.txt` `Disallow: /`; у фронтенді — помітний банер «Тестове середовище» (значення приходить з бекенду, напр. у наявному публічному конфіг-ендпоінті, або з `/api/health/live` — обрати наявний механізм конфігу фронтенду).
- [ ] Окремий Telegram-бот (токен тестового бота), окремі OAuth-застосунки Google/Discord з redirect URI dev-домену, свій `CALENDAR_IMPORT_KEY`. Усе — у шаблоні env з коментарями.
- [ ] `docs/ops/environments.md`: таблиця local/dev/prod (домен, бот, OAuth, бекапи, індексація), покроковий запуск dev-сервера, як не переплутати токени.
- [ ] Тести: env-валідація `DEPLOY_ENV`; заголовок noindex на dev і його відсутність на prod; банер у фронті.
- [ ] Коміт.

### Task 4: Чернетка без дати старту

**Files:** `shared/src/contracts/games.ts`, `backend/src/db/schema/games.ts` + міграція, `backend/src/games/*.ts`, `backend/src/sessions/materialize.ts`, усі споживачі `games.startsAt` (grep), `frontend/src/app/features/games/game-form/*`, картки/деталі гри, `uk.json`.

- [ ] `games.starts_at` — nullable. `GameDto.startsAt: string | null`. У `gameInputSchema` `startsAt` nullable; правило розкладу перевіряє день тижня лише коли дата є.
- [ ] Зберегти чернетку без дати — можна. Перехід `draft → recruiting` (публікація) без дати — 422 `GAME_START_REQUIRED` (новий код у `shared/src/errors.ts`). Редагування гри не в статусі draft зі `startsAt: null` — 422 `GAME_START_REQUIRED`.
- [ ] Матеріалізація сесій, нагадування, детектор «мертвих» ігор, ICS, пошук — `null` пропускають (чернетки й так не публічні, але не падати).
- [ ] `cloneGame` — `startsAt: null` (прибрати `copyStartsAt`, якщо більше не потрібен).
- [ ] Фронт: у формі поле дати можна очистити, поки гра — чернетка; кнопка «Опублікувати» без дати показує зрозумілу помилку; деталі/картки чернетки — «Дату ще не визначено».
- [ ] Тести backend (зберегти без дати, публікація → 422, клон → null), shared (схема), frontend (форма).
- [ ] Коміт.

### Task 5: Приблизний час — backend

**Files:** `shared/src/contracts/games.ts`, `shared/src/contracts/sessions.ts`, схеми `games`/`game_sessions` + міграція, `backend/src/sessions/*.ts`, `backend/src/games/games.service.ts` (перехід `start`), нагадування/сповіщення сесій, `backend/src/calendar/ics.ts`, `bot/src/delivery/render.ts` (+ i18n бота).

- [ ] Колонки `start_window_minutes` (int, nullable) у `games` і `game_sessions`. Константи в shared: `START_WINDOW_MIN = 30`, `START_WINDOW_MAX = 720`, крок 30.
- [ ] Гра: `startWindowMinutes` у `gameInputSchema`/`GameDto`. Сесії, матеріалізовані з правила, успадковують вікно гри (на момент матеріалізації; зміна гри оновлює майбутні неперенесені rule-сесії — так само, як зараз оновлюється їхній час).
- [ ] Сесія: `startWindowMinutes` у `SessionDto`; `rescheduleSessionInputSchema` і створення ручної сесії приймають `startWindowMinutes` (nullable). «Уточнити час» = reschedule з точним `startsAt` і `startWindowMinutes: null` (окремий ендпоінт не потрібен). Сповіщення про перенесення показує вікно або точний час.
- [ ] Перехід гри `start`: якщо найближча `scheduled` сесія гри має вікно — 409 `SESSION_TIME_APPROXIMATE` з `details: { sessionId }`. `finishSession` для сесії з вікном — 409 `SESSION_TIME_APPROXIMATE`.
- [ ] Майстру — нагадування «уточни час» за 24 год до початку вікна (новий тип сповіщення `session.time_unpinned`, категорія як у інших сесійних для майстра; один раз на сесію — колонка-штамп або наявний reminder-log). Нагадування учасникам `session.reminder` — від початку вікна, текст із вікном.
- [ ] ICS: подія з вікном — `DTSTART` = початок вікна, `DTEND` = кінець вікна + тривалість, у `SUMMARY` — «(час уточнюється)».
- [ ] Підказка часу всередині вікна: `GET /api/sessions/:id/window-slots` (лише майстер) — для кожного 30-хв старту у вікні кількість учасників, вільних на всю тривалість, і хто не може; використати наявний механізм підбору часу (group scheduling, `backend/src/scheduling/`).
- [ ] Тести: схеми, успадкування вікна, start/finish → 409, уточнення часу, нагадування майстру (раз), ICS-рядки, перехід на літній час для вікна, window-slots.
- [ ] Коміт.

### Task 6: Приблизний час — frontend

**Files:** `game-form`, `sessions-list`, `reschedule-dialog` / діалог ручної сесії, `game-details` (кнопка «Почати гру»), `core/games`, `core/sessions` API, `uk.json`.

- [ ] Форма гри й діалоги сесії: перемикач «Точний час / Приблизно» → для приблизного — «з» і «до» (селекти з кроком 30 хв); до > з, максимум 12 год.
- [ ] Список сесій і деталі: «Пт, 5 груд., 18:00–21:00 · час уточнюється»; у майстра біля такої сесії — кнопка «Уточнити час» → діалог із варіантами старту у вікні й кількістю вільних (дані з `window-slots`), вибір → reschedule з точним часом.
- [ ] «Почати гру» при 409 `SESSION_TIME_APPROXIMATE` — пояснення й посилання/кнопка до «Уточнити час»; так само для «Завершити сесію».
- [ ] Сповіщення `session.time_unpinned` — рядок у `notification-view.ts` і `uk.json`.
- [ ] Тести компонентів.
- [ ] Коміт.

### Task 7: Аватари — backend

**Files:** `backend/src/db/schema/auth.ts` / `users.ts` + міграція, `backend/src/auth/identity.service.ts`, провайдери, ендпоінт профілю (`/api/me…`), `shared/src/contracts/` (профіль/юзер), `backend/src/http/image-url.ts`.

- [ ] `auth_identities.avatar_url` (nullable, 512): записується при кожному вході провайдером (Google `picture`, Discord CDN, Telegram `photo_url`); заповнити з поточного `users.avatar_url` для першої identity користувача в міграції не обов'язково — достатньо оновлення при наступному вході (зазначити).
- [ ] `users.avatar_source` enum `auto | google | discord | telegram | custom | none` (дефолт `auto` = як зараз: аватар першого/останнього провайдера) і `users.custom_avatar_url` (nullable). `users.avatar_url` лишається обчисленим «ефективним» значенням (щоб не чіпати всіх споживачів) — перераховується при вході і при зміні вибору.
- [ ] `PUT /api/me/avatar` `{ source, customUrl? }`: source має бути серед прив'язаних провайдерів з аватаром (інакше 422 `AVATAR_SOURCE_UNAVAILABLE`); `custom` — перевірка `image-url.ts` (422 `IMAGE_URL_INVALID`, ліміт `imageCheck`). `GET` профілю повертає `avatarSource`, `customAvatarUrl` і доступні джерела з прев'ю-URL.
- [ ] Тести.
- [ ] Коміт.

### Task 8: Аватари — frontend

**Files:** сторінка налаштувань профілю (`features/profile/...`), `core` API, `uk.json`.

- [ ] Блок «Аватар»: варіанти з прев'ю (Google / Discord / Telegram — лише доступні; «Власне посилання» з полем і перевіркою; «Без аватара»), збереження, помилки `IMAGE_URL_INVALID` з причиною, `AVATAR_SOURCE_UNAVAILABLE`.
- [ ] Тести компонента.
- [ ] Коміт.

### Task 9: Фінал

- [ ] Повні тести всіх воркспейсів, typecheck, lint, build; QA-розділ у `docs/QA-features.md` (§16); беклог — що відкладено.
