# НРІ Асистент — План 11: пауза кампейну й донабір

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Майстер може поставити кампейн на паузу й пізніше відновити його або оголосити донабір з новою датою першої сесії.

**Architecture:** Новий статус гри `paused` і дії `pause` / `resume` у наявній машині станів (`backend/src/games/games.service.ts`, `POST /api/games/:id/<action>`). Пауза скасовує майбутні сесії (`cancelFutureSessions`), відновлення перезапускає правило з нової дати (`replaceRuleSessions` / матеріалізація) і ставить `showWhenFull` за вибором «донабір». Видимість, заявки, календар зайнятості, детектор «мертвих» ігор і сповіщення враховують `paused`.

**Tech Stack:** як у попередніх планах (Express + Drizzle/MySQL, `@nri/shared`, Angular 22, grammY-бот для Telegram-сповіщень).

**Spec:** `docs/superpowers/specs/2026-11-26-campaign-pause-design.md`.

## Global Constraints

- `GAME_STATUSES` += `'paused'`; `GAME_ACTIONS` += `'pause' | 'resume'`. `pause`: з `recruiting|started`, лише `kind='campaign'`, лише майстер гри (не адмін, не модератор). `resume`: з `paused`, тіло `{ startsAt: ISO (ціла хвилина, у майбутньому), recruit: boolean }`.
- Причина паузи: `reason ∈ ['vacation','illness','study_work','other']` + `note` ≤ 300 символів (необов'язково); видно учасникам і майстру, не гостям і не в пошуку.
- Пауза: усі майбутні `scheduled` сесії → `cancelled` з причиною `campaign_paused`; календар зайнятості й нагадування їх не бачать; заявки — 409/відмова з кодом помилки (новий `GAME_PAUSED`); `pending`-заявки лишаються (майстер вирішить після відновлення) — рішення виконавця, задокументувати.
- Відновлення: `status='started'`, `showWhenFull = recruit`, правило розкладу перезапускається від `startsAt` (дні тижня/частота — ті самі; `startsAt` має припадати на один з днів правила, як при створенні — валідація як у `gameInputSchema`).
- Пошук і sitemap/SEO: `paused` не показується; сторінка гри доступна учасникам, майстру й за прямим посиланням для тих, хто бачив гру раніше — як `started` без `showWhenFull` (перевірити `games.visibility.ts`).
- Детектор «мертвих» ігор ігнорує `paused`; через 90 днів паузи — одне нагадування майстру (сповіщення) з діями «відновити / донабір / завершити»; не повторювати частіше ніж раз на 30 днів.
- Сповіщення учасникам: `game.paused`, `game.resumed` (з датою першої сесії й позначкою донабору) — сайт + Telegram за наявними налаштуваннями.
- Час — у поясі глядача без позначки поясу. Тексти — `uk.json`. Логіка — на бекенді/у shared; фронтенд показує. Слоти дизайнів не змінюють контракт; бейдж «На паузі» — через спільну view-model (`badges`), щоб усі 10 дизайнів його показали.
- Як у попередніх планах: тести (shared, backend, frontend), typecheck, lint, build зелені; міграція через drizzle-kit; prettier лише на змінених файлах; один процес тестів бекенду; ролі в dev-БД не змінювати; медіа — лише в `.media/`.

## Review Focus

1. **Гонки й права:** `pause`/`resume` від не-майстра (учасник, адмін) → 403; повторний `pause` → 409; `resume` з минулою датою чи днем поза правилом → 400.
2. **Сесії:** після паузи жодна майбутня сесія не лишається `scheduled`; минулі й уже скасовані не змінюються; після відновлення сесії з'являються від нової дати й не дублюються (UNIQUE по `rule_starts_at`).
3. **Видимість:** `paused` не з'являється в пошуку, sitemap, рекомендаціях; заявка через API → `GAME_PAUSED`.
4. **Детектор і нагадування:** `paused` не стає «мертвим»; нагадування через 90 днів — рівно одне на період.
5. **Усі дизайни:** бейдж «На паузі» видно в 10 дизайнах; кнопки майстра доступні з клавіатури; діалоги читабельні в темних і світлих дизайнах.

---

### Task 1: Бекенд і shared — статус, дії, сесії, заявки, видимість

**Files:** `shared/src/contracts/games.ts` (+ тести), міграція (enum статусу `paused`, `paused_at`, `pause_reason`, `pause_note`), `backend/src/games/games.service.ts`, `games.routes.ts`, `games.visibility.ts`, `games.search.ts`, `backend/src/applications/applications.service.ts`, `backend/src/sessions/materialize.ts` (за потреби), календар зайнятості з ігор (`backend/src/calendar/game-busy.service.ts`), DTO гри (`paused`, `pauseReason`, `pauseNote`, `pausedAt` — причина лише для учасників/майстра), тести бекенду.

- [ ] Тести (RF 1–3): переходи й права; скасування майбутніх сесій з `campaign_paused`; відновлення з `startsAt`/`recruit` (сесії від нової дати, `showWhenFull`); заявка на `paused` → `GAME_PAUSED`; `paused` поза пошуком і sitemap; DTO не віддає причину стороннім.
- [ ] **Commit** `feat(backend): pause and resume campaigns`

### Task 2: Детектор, нагадування, сповіщення

**Files:** `backend/src/games/dead-games/*`, сповіщення (`shared/src/contracts/notifications.ts`, бекенд-диспетчер, Telegram-шаблони бота), тести.

- [ ] Тести (RF 4): детектор пропускає `paused`; нагадування через 90 днів — одне, повтор не раніше ніж за 30 днів; `game.paused` / `game.resumed` отримують активні учасники (не майстер-ініціатор, не вибулі) за їхніми налаштуваннями.
- [ ] **Commit** `feat: pause notifications and long-pause reminder`

### Task 3: Фронтенд

**Files:** сторінка гри (дії майстра: «Поставити на паузу» з діалогом причини; на `paused` — «Відновити» / «Оголосити донабір» з діалогом дати першої сесії), «Мої ігри», картки (через спільні view-models — бейдж «На паузі»), сповіщення (тексти нових типів), `uk.json`, specs.

- [ ] Specs: кнопки лише майстру; діалоги валідують дату (майбутня, день правила); бейдж у VM; заявка недоступна; тексти сповіщень.
- [ ] Браузер: сценарій пауза → донабір у двох дизайнах (світлому й темному), 1440 і 375; скріншоти в `.media/pause/`.
- [ ] **Commit** `feat(frontend): campaign pause and re-recruitment`

### Task 4: Фінальна перевірка

- [ ] `npm test && npm run typecheck && npm run lint && npm run build -w frontend`; `docs/QA-features.md` (пауза/донабір), `docs/superpowers/backlog.md` («Після Плану 11»). **Commit** `docs: plan 11 verification`
