# НРІ Асистент — План 7: «Мертві» ігри, каталог систем, Discord

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Покинуті ігри не засмічують пошук (нагадування → «мертва» → м'який блок створення), підозрілі накладання видно майстру й адміну; адміністрація редагує каталог систем; можна входити через Discord.

**Architecture:** Модуль `backend/src/games/dead-games/` з правилами як підключуваними функціями (`staleRule`, `overlapRule`) і щоденною задачею планувальника; стан — колонки в `games`. Каталог — адмін-ендпоінти над наявними `game_systems`. Discord — ще один провайдер за наявною абстракцією `auth/providers` (OAuth 2.0 + PKCE). Фронт — пояснення блоку у формі гри, позначки в «Моїх іграх», дві вкладки адмінки, кнопка Discord.

**Tech Stack:** як у Плані 6. Нових залежностей немає (`openid-client` уже є; Discord без OIDC — звичайний OAuth2 через наявний клієнт або `fetch`).

**Spec:** `docs/superpowers/specs/2026-11-25-plan-7-dead-games-catalog-discord-design.md` (затверджено).

## Global Constraints

- Перевіряються ігри у статусах `recruiting`/`started`. «Проведена» = `game_sessions.status = 'done'`. Відлік = max(остання `done_at`, `published_at`, перша не скасована запланована сесія `starts_at`).
- Пороги: нагадування > 30 днів; «мертва» > 90 днів; повтор після «все ок» — 14 днів; накладання — ≥ 3 перетини інтервалів `[starts_at, starts_at + duration)` сесій (done + scheduled не скасовані) двох активних ігор майстра за останні 4 тижні; адмінське зняття «підозрілої» — на 4 тижні; адмінське зняття «мертвої» — до наступної проведеної сесії.
- «Мертва»: прихована з пошуку й sitemap/SEO-списків; видима за посиланням, учасникам і в профілі майстра; майстру — 409 `GAME_CREATION_BLOCKED` (`details.deadGameIds`) на створення гри.
- Закриття «мертвої»: `recruiting` → `cancelled`, `started` → `finished` (звичайні наслідки: скасування сесій/заявок, вікна оцінок); від адміна — `closed_by_admin = true`, журнал модерації, сповіщення майстру.
- Сповіщення в категорії `games`: `game.stale_reminder`, `game.dead`, `game.suspicious`, `game.closed_by_admin`; дедуп журналом.
- Каталог: адмін і власник; зміни пишуть журнал і скидають кеш каталогу.
- Discord: змінні `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` (документовані в `.env.template`); без них ендпоінти — 404, кнопка не показується. Правила прив'язки, надгробків і банів — як для Google.
- Як у попередніх планах: компоненти .ts/.html/.less; тексти `uk.json` (фронт і бот); контракти в `@nri/shared`; права на бекенді; UTC; prettier лише змінені файли; усі перевірки зелені.

## Review Focus

1. **Хибна «мертвість»:** кампанія з проведеною сесією 89 днів тому, ігра з першою сесією в майбутньому, гра після «все ок» — не блокують. Тест — Task 1.
2. **Самознімання:** щойно сесію відмічено проведеною — «мертвість» знімається (наступний прогін або одразу при відмітці). Тест — Task 1.
3. **Витік прихованої гри:** «мертва» гра не з'являється в пошуку/sitemap, але учасник і прямий лінк її бачать. Тест — Task 1.
4. **Discord-прив'язка:** чужа Discord-ідентичність → конфлікт; банований надгробок → `IDENTITY_BANNED`; state/PKCE перевіряються. Тест — Task 2.
5. **Каталог:** вимкнена система не пропонується в нових іграх, але наявні ігри зберігають її й коректно відображаються. Тест — Task 2.

---

### Task 1: Детектор «мертвих» ігор (бекенд)

**Files:** міграція `0027_plan7_dead_games.sql` (`games.dead_at`, `dead_snoozed_until`, `dead_exempt_until_session` bool, `suspicious_at`, `suspicious_dismissed_until`, `closed_by_admin`; журнал нагадувань `game_staleness_log(game_id, kind, period_key, UNIQUE)`); Create `backend/src/games/dead-games/{rules.ts, detector.ts, dead-games.routes.ts}`; Modify `games.search.ts`, `seo.routes.ts`, `games.service.ts` (створення гри — блок; відмітка сесії `done` знімає `dead_at`), notifications (типи + тексти бота/фронту), `jobs/index.ts`, moderation routes (адмін-список/закрити/зняти позначку), shared контракти; tests.

**Interfaces:** `staleRule(game, now) → 'ok'|'remind'|'dead'`; `overlapRule(db, gmId, now) → Set<gameId>`; `runDeadGamesDetector(deps, now)` (щоденно 04:00 UTC: встановлює/знімає `dead_at` і `suspicious_at`, шле сповіщення з дедупом); `POST /api/games/:id/still-alive` (майстер; знімає `dead_at`, `dead_snoozed_until = now+14d`); `POST /api/games/:id/close-dead` (майстер; за правилом закриття); `GET /api/me/dead-games` (для форми створення); `GET /api/admin/dead-games?kind=dead|suspicious` (модератор+), `POST /api/admin/dead-games/:id/close`, `POST /api/admin/dead-games/:id/dismiss`.
- [ ] Тести: (**RF 1**) межі 30/90 днів, перша сесія в майбутньому, «все ок» на 14 днів, адмінське зняття до наступної сесії; (**RF 2**) відмітка сесії знімає «мертвість»; (**RF 3**) пошук/sitemap/учасник/лінк; накладання ≥3 за 4 тижні (2 → ні), автозняття, адмінське зняття на 4 тижні; блок створення з `deadGameIds`; закриття recruiting→cancelled, started→finished; сповіщення без дублів. **Commit** `feat(backend): dead games detector`

### Task 2: Каталог систем і Discord (бекенд)

**Files:** Create `backend/src/catalog/catalog.admin.routes.ts`; Modify catalog service (кеш, фільтр `is_active` у створенні гри — наявні ігри з вимкненою системою валідні при редагуванні без зміни системи); Create `backend/src/auth/providers/discord.ts`; Modify auth routes (start/callback для login і link, як Google), `.env.template`, shared контракти (`MeDto`/identities, `runtimeConfig` прапорець для фронту — як `googleLogin`), tests.

**Interfaces:** `GET /api/admin/catalog/systems` (усі, з `isActive`), `POST /api/admin/catalog/systems {name, slug, defaultGenreId, sort}`, `PATCH /api/admin/catalog/systems/:id {name?, defaultGenreId?, sort?, isActive?}` (адмін+; журнал `catalog.*`; 409 на дубль slug). Discord: `GET /api/auth/discord/start?mode=login|link&returnTo`, `GET /api/auth/discord/callback` (state + PKCE S256, обмін коду, `GET https://discord.com/api/users/@me`, subject = id).
- [ ] Тести: (**RF 5**) вимкнена система не приймається в новій грі, наявна гра редагується; кеш скидається; права (модератор → 403); (**RF 4**) Discord: мок HTTP — новий користувач, прив'язка до наявного, конфлікт, банований надгробок, невалідний state; без змінних — 404. **Commit** `feat(backend): catalog admin and discord login`

### Task 3: Фронтенд

**Files:** форма створення гри (пояснення `GAME_CREATION_BLOCKED` зі списком «мертвих» ігор і кнопками «Все ок» / «Закрити»), «Мої ігри» (позначки «давно не проводилась» / «мертва» / «підозріла» з тими ж діями), адмінка: вкладки «Мертві ігри» (модератор+) і «Каталог» (адмін+), вхід і акаунт — кнопка Discord (за прапорцем), сторінка гри для учасника — без змін; `uk.json`; specs.
- [ ] Specs: блок у формі з діями, позначки в «Моїх іграх», вкладки адмінки (права, закрити/зняти, додати/вимкнути систему), кнопка Discord з'являється лише за прапорцем. Бандл не росте (ліниві вкладки). **Commit** `feat(frontend): dead games notices, catalog admin, discord login`

### Task 4: Фінальна перевірка

- [ ] `npm test && npm run typecheck && npm run lint && npm run build -w frontend`; `docker build` трьох образів.
- [ ] Ручна перевірка в браузері: гра з минулою датою (через dev-БД) → після прогону детектора зникає з пошуку, майстер бачить позначку, «Все ок» повертає; адмін додає й вимикає систему; кнопка Discord без змінних не видна.
- [ ] Оновити `docs/superpowers/backlog.md` («Після Плану 7»: справжня перевірка Discord власником тощо). **Commit** `docs: plan 7 verification and backlog`
