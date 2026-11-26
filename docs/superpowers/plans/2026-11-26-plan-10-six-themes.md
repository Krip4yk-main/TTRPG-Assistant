# НРІ Асистент — План 10: шість нових дизайнів

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Додати шість доступних усім дизайнів: `dungeon`, `gothic-gloom`, `magicpunk`, `brass-steam`, `solar-garden`, `painted-city`.

**Architecture:** Система дизайнів Планів 8–9 (`frontend/src/app/theming/`). Кібер-родину (`themes/cyber/`) узагальнено в «сцену» (`themes/scene/`): спільні компоненти слотів (один лінивий чанк для всіх дизайнів сцени), спільна основа стилів `scene-base.less` + `scene-material.scss`, а кожен дизайн — свій бандл `theme-<id>.css` з токенами, шрифтами й декором під `:root[data-theme='<id>']`.

**Tech Stack:** як у Плані 9. Нові залежності — `@fontsource/*` шрифти зі спеки (лише потрібні ваги, кирилиця + латиниця).

**Spec:** `docs/superpowers/specs/2026-11-26-six-themes-design.md`. Еталони: `docs/design-concepts/themes2/*.html|png` (HTML — джерело кольорів/розмірів; Google Fonts і picsum не переносити).

## Global Constraints

- `THEME_IDS = ['quest-board', 'neon-signs', 'holo-market', 'night-city', 'dungeon', 'gothic-gloom', 'magicpunk', 'brass-steam', 'solar-garden', 'painted-city']`; `DEFAULT_THEME = 'quest-board'`; усі `themeAccess` — `'everyone'`.
- Назви: `theme.names.dungeon` «Підземелля», `gothic-gloom` «Готичний морок», `magicpunk` «Магіпанк», `brass-steam` «Латунь і пара», `solar-garden` «Сонячний сад», `painted-city` «Мальоване місто».
- Без назв/символів/місць/персонажів чужих франшиз.
- Дизайн не обмежує функціонал; контракти слотів (`theming/slots.ts`) не змінюються; логіка — у спільних view-model функціях; уся картка клікабельна через `isCardOpenClick`; обкладинка — спільна директива `CoverAttachment`.
- Контраст тексту ≥ 4.5:1 (дрібний), ≥ 3:1 (великий/іконки), розрахунок у коментарях до токенів; декор не накладається на основний текст; декор з площею — `pointer-events: none`.
- Анімації — лише `@media (prefers-reduced-motion: no-preference)`, ледь помітні.
- Сталий розмір картки пошуку; трикрапка + `truncate-tooltip`; поля вводу ніколи не повернуті.
- Текстури-плитки без швів: у data-URI SVG `<filter x='0' y='0' width='1' height='1'>`, `stitchTiles='stitch'`, `baseFrequency × розмір плитки` — ціле число.
- Час — у поясі глядача без позначки поясу.
- Шрифти й іконки локальні; hex лише в `styles/themes/**` і `app/theming/themes/**`.
- Вигляд «Дошки оголошень» і трьох кібер-дизайнів не змінюється (порівняння скріншотів пошуку до/після кожної задачі, що чіпає спільний код).
- Компоненти .ts/.html/.less; тексти `uk.json`; prettier лише на змінених файлах; `npm test`, typecheck, lint, `npm run build -w frontend` зелені; бюджет початкового бандла не росте. Не запускати два процеси тестів бекенду одночасно. Не змінювати ролі в dev-БД; змінений для перевірок `ui_theme` демо-користувача повертати.

## Review Focus

1. **Перейменування кібер-родини** не змінило вигляд і поведінку трьох кібер-дизайнів (пікселі пошуку й «Моїх ігор» до/після). — Task 1.
2. **Світла схема** («Сонячний сад»): поля, меню, датапікер, скролбари Material світлі й читабельні; немає темних «плям» від основи сцени. — Task 6.
3. **Декор** (ланцюги, печатки, проєкції, листя) не перехоплює кліки й не дає горизонтального скролу на 375px. — Tasks 2–7.
4. **Десять дизайнів у «Вигляді»**: сітка мініатюр не ламається на 375px, вибір застосовується без кадру без стилів. — Task 8.
5. **Сторінки поза пошуком** у кожному новому дизайні: немає нечитабельного тексту й невидимих меж полів. — Task 8.

---

### Task 1: Кібер-родина → «сцена»

**Files:** перейменувати `frontend/src/app/theming/themes/cyber/` → `themes/scene/` (компоненти `Cyber*` → `Scene*`, селектори `nri-cy-*` → `nri-sc-*`, класи й змінні `cy-`/`--cy-*` → `sc-`/`--sc-*`, `cyber-base.less` → `scene-base.less`, `cyber-material.scss` → `scene-material.scss`, ключі `uk.json` `cyber.*` → `scene.*`), оновити бандли `neon-signs`/`holo-market`/`night-city`, реєстр, specs.

- Основа: параметри `--sc-font-body`, `--sc-font-mono` (типові — Golos Text / JetBrains Mono, кібер-дизайни не змінюються); підтримка світлої схеми (`--sc-scheme: light|dark` або окремий міксин для світлих оверлеїв Material/скролбарів/нативних select); загальні декоративні гачки картки й «Моїх ігор» замість іменованих під кібер (напр. `sc-d1…sc-d4` на хості поза панеллю, `sc-p1…sc-p2` усередині панелі — назви на розсуд, задокументувати в шапці `scene-base.less`, кожен дизайн у своєму бандлі описує, чим вони є). Кібер-бандли переходять на нові гачки без зміни вигляду.
- [ ] Specs зелені (оновлені імена); contract-specs `describe.each` — `quest-board` і `night-city`.
- [ ] Піксельне порівняння пошуку й «Моїх ігор» трьох кібер-дизайнів до/після (1440) — без відмінностей, окрім шуму згладжування (**RF 1**).
- [ ] **Commit** `refactor(frontend): cyber family becomes the shared scene family`

### Task 2: «Підземелля» (`dungeon`)
### Task 3: «Готичний морок» (`gothic-gloom`)
### Task 4: «Магіпанк» (`magicpunk`)
### Task 5: «Латунь і пара» (`brass-steam`)
### Task 6: «Сонячний сад» (`solar-garden`, світлий)
### Task 7: «Мальоване місто» (`painted-city`)

Для кожної з Tasks 2–7 (однаковий обсяг):

**Files:** `shared/src/contracts/theme.ts` (+ тест) — додати id; `backend/test/users/users.test.ts` — PATCH з новим id → 200 (один тест на задачу); Create `frontend/src/app/theming/themes/<id>/{<id>.less, <id>-material.scss}`; `angular.json` (бандл `theme-<id>`), `index.html` (інлайн-мапа + ранній фон; перерахувати CSP-хеш у `docs/superpowers/backlog.md`), `theme.registry.ts` (`loadSlots` — спільний чанк сцени), `uk.json` (назва), `frontend/package.json` (`@fontsource` шрифти дизайну), тимчасова мініатюра `frontend/public/themes/<id>.png` (обрізаний макет; Task 8 замінить); при потребі — декоративна розмітка в спільних компонентах сцени через загальні гачки (без зміни контрактів).

- За макетом зі спеки: стіна-фон, шапка, заголовок сторінки, панель фільтрів, картка пошуку (декор, ціна, «Підходить», вік, «Нове», місця, підпис майстра), обкладинка-вкладення, «Мої ігри», порожні стани, бейджі; форми/діалоги/Material — у кольорах дизайну.
- [ ] Specs: `availableThemes('user')` містить id; contract-specs проходять (спільні компоненти).
- [ ] Браузер: пошук, «Мої ігри», сторінка гри, форма гри, налаштування — 1440 і 375, без горизонтального скролу; скріншоти в `docs/design-concepts/themes2/built/<id>/`; порівняння з макетом.
- [ ] Інші дизайни без змін (вибіркові скріншоти). **Commit** `feat(frontend): <назва англ.> theme` (напр. `dungeon theme`).

### Task 8: Увесь сайт, мініатюри, фінальна перевірка

**Files:** `frontend/public/themes/<id>.png` для шести дизайнів (реальні скріншоти пошуку 480×300, як інші); виправлення стилів сторінок; `docs/QA-features.md` (10 дизайнів); `docs/superpowers/backlog.md` («Після Плану 10»).

- [ ] Аудит кожного нового дизайну: усі маршрути `app.routes.ts` і вкладки `/admin`, desktop + mobile; меню, діалоги, датапікер, автодоповнення, банери (**RF 2, 5**).
- [ ] «Вигляд»: 10 мініатюр, 375px без ламання (**RF 4**).
- [ ] `npm test && npm run typecheck && npm run lint && npm run build -w frontend` зелені. **Commit** `feat(frontend): six themes across the site and previews`
