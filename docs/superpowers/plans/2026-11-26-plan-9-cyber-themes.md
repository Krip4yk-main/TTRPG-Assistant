# НРІ Асистент — План 9: три кібер-дизайни замість «Класичного»

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Прибрати «Класичний» і додати три доступні всім кібер-дизайни: `neon-signs`, `holo-market`, `night-city`.

**Architecture:** Система дизайнів Плану 8 (`frontend/src/app/theming/`). Нова «кібер-родина» в `theming/themes/cyber/`: спільні компоненти слотів (вантажаться одним лінивим чанком для всіх трьох дизайнів), спільна основа стилів (`cyber-base.less` + `cyber-material.scss`), а кожен дизайн — свій бандл `theme-<id>.css` з токенами й варіантом вигляду, що спирається на `:root[data-theme='<id>']`.

**Tech Stack:** як у Плані 8. Нові dev-залежності: `@fontsource/golos-text`, `@fontsource/jetbrains-mono`, `@fontsource/m-plus-rounded-1c`, `@fontsource/jura`, `@fontsource/unbounded` (лише потрібні ваги, кирилиця + латиниця).

**Spec:** `docs/superpowers/specs/2026-11-26-cyber-themes-design.md`. Візуальні еталони: `docs/design-concepts/cyberpunk/*.html|png` (відкривати HTML як джерело кольорів/розмірів; Google Fonts і picsum звідти НЕ переносити).

## Global Constraints

- `THEME_IDS = ['quest-board', 'neon-signs', 'holo-market', 'night-city']`; `DEFAULT_THEME = 'quest-board'`; усі `themeAccess` — `'everyone'`; `'classic'` більше не існує ніде в коді (збережене в БД значення → дефолт через `resolveTheme`).
- Назви: `theme.names.neon-signs` «Неонові вивіски», `theme.names.holo-market` «Голо-ринок», `theme.names.night-city` «Нічне місто».
- Дизайн не обмежує функціонал; контракти слотів (`theming/slots.ts`) не змінюються; логіка — у спільних view-model функціях.
- Контраст тексту ≥ 4.5:1 (дрібний), ≥ 3:1 (великий/іконки), перевірений розрахунком у коментарях до токенів. Неон/сканлайни/мерехтіння не накладаються на основний текст.
- Анімації (мерехтіння, дощ, блимання літери) — лише `@media (prefers-reduced-motion: no-preference)`, ледь помітні.
- Розмір картки пошуку сталий (як у «Дошці»: ширина від сітки, висота токеном), довгі рядки — трикрапка + `truncate-tooltip`; поля вводу ніколи не повернуті.
- Час — у поясі глядача без позначки поясу.
- Шрифти й іконки локальні; `color-scheme: dark` для трьох кібер-дизайнів; hex — лише в `styles/themes/**` і `app/theming/themes/**` (stylelint `color-no-hex`).
- Вигляд «Дошки оголошень» не змінюється (порівняти скріншоти пошуку до/після кожної задачі, що чіпає спільний код).
- Як у попередніх планах: компоненти .ts/.html/.less; тексти `uk.json`; prettier лише на змінених файлах; `npm test`, `npm run typecheck`, `npm run lint`, `npm run build -w frontend` зелені; бюджет початкового бандла не росте. Не запускати два процеси тестів бекенду одночасно. Не змінювати ролі користувачів у dev-БД.

## Review Focus

1. **Збережений `classic`** у `localStorage` гостя чи в `users.ui_theme`: після init — `quest-board`, жодних 404 на `theme-classic.css`, інлайн-скрипт не ламається. Тест — Task 1.
2. **Перемикання між кібер-дизайнами** (`neon-signs` → `night-city`): чанк слотів не перевантажується, а старий `<link>` бандла прибирається й `data-theme` міняється — вигляд справді інший. Тест — Task 1/2.
3. **Обкладинка** в кібер-дизайнах: та сама поведінка, що в «Дошці» (Esc, клік деінде, клік по вкладенню не навігує, зламане зображення ховається), і «Дошка» після винесення поведінки працює як раніше. Тест — Task 2.
4. **Сторінки поза пошуком** (форми, діалоги Material, адмінка, календар) у темних дизайнах: немає світлих «плям», нечитабельного тексту, невидимих меж полів. Перевірка — Task 5 (браузер).
5. **Мобільна 375px**: декор (шина, проєктори, неон) не створює горизонтального скролу, картка в одну колонку. Тест/перевірка — Tasks 2–5.

---

### Task 1: Прибрати «Класичний», зареєструвати три кібер-дизайни, основа «Нічного міста»

**Files:**
- Modify `shared/src/contracts/theme.ts` (+ `theme.test.ts`), `backend/test/users/users.test.ts` (тести з `classic`).
- Delete `frontend/src/app/theming/themes/classic/**`, `frontend/public/themes/classic.png`; Modify `frontend/angular.json` (бандли), `frontend/src/index.html` (інлайн-мапа + CSP-хеш у `docs/superpowers/backlog.md` перерахувати), `theme.registry.ts`, specs що використовують `classic` (`theme.service.spec.ts`, `slot.spec.ts`, `slot-contract.spec.ts`, `theme-picker.spec.ts`, `my-games.spec.ts`, ...), `uk.json`.
- Create `frontend/src/app/theming/themes/cyber/{slots.ts, cyber-base.less, cyber-material.scss, shell/*, page-header/*, empty-state/*, badge/*, gm-signature/*, my-game-item/*}`; Create `frontend/src/app/theming/themes/night-city/{night-city.less, night-city-material.scss}` (бандл `theme-night-city`); тимчасово `game-card` слот кібер-родини може бути спільним fallback-ом до Task 2.
- `package.json` фронтенду: шрифти `@fontsource/*` з Tech Stack.

**Interfaces:**
- Produces: `THEMES['neon-signs'|'holo-market'|'night-city']` з `loadSlots: () => import('./themes/cyber/slots').then(m => m.CYBER_SLOTS)`; `CYBER_SLOTS: ThemeSlots`; спільні стилі `cyber-base.less` імпортуються бандлом кожного кібер-дизайну й параметризуються CSS-змінними `--cy-*` (назви на розсуд виконавця, задокументувати в шапці файлу); `--qb-*` не використовувати.
- Реєстр/інлайн-скрипт: усі три з `colorScheme: 'dark'` і раннім фоном зі свого макета.

- [ ] Тести shared: `availableThemes('user')` = усі 4; `resolveTheme('classic', 'owner') === 'quest-board'`; `resolveTheme('night-city', 'user') === 'night-city'`.
- [ ] Тести бекенду: `PATCH /api/me/theme {theme:'night-city'}` від звичайного користувача → 200; `{theme:'classic'}` → 400.
- [ ] Specs фронтенду: `ThemeService` з `localStorage['nri.theme']='classic'` → `quest-board`, жодного `<link>` на `theme-classic`; `select('neon-signs')` після `night-city` міняє `data-theme` і `<link>`, а `loadSlots` кібер-родини викликається один раз (**RF 1, 2**). Спільні contract-specs (`describe.each`) проганяються для `quest-board` і `night-city`.
- [ ] «Нічне місто» за макетом `cyber-ac-hybrid`: шапка, бетонна стіна, заголовок сторінки-вивіска, панель фільтрів, «Мої ігри», порожні стани, бейджі, підпис майстра — і темні поверхні всього сайту (форми, Material-поля/меню/діалоги/календар, таблиці адмінки) через `cyber-base.less` + `cyber-material.scss`.
- [ ] `npm test`, typecheck, lint, build зелені. **Commit** `feat(frontend): cyber theme family and night city base; drop classic`

### Task 2: Картка гри кібер-родини + спільна обкладинка-вкладення

**Files:** Create `theming/themes/cyber/game-card/*` (+ spec); винести поведінку `theming/themes/quest-board/attachment/*` у спільне місце (`theming/shared/attachment/` або директива) і використати в «Дошці» й кібер-картці; `theming/themes/night-city/night-city.less` — вигляд картки «Нічного міста» (скляна панель, неонова смужка, шина живлення з двома затискачами-LED у кольорі картки, обкладинка-знімок за кутом).

**Interfaces:** Consumes `GameCardSlot` (`theming/slots.ts`), `GameCardVm`. Produces: `CyberGameCard` з `data-neon` (0–5, стабільно за id гри; чиста функція з тестом, як `paperVariant`) і декоративними елементами для всіх трьох варіантів (видимі лише в бандлі свого дизайну).

- [ ] Specs (**RF 3**): вкладення — Esc ховає, клік по ньому не навігує, `error` зображення ховає вкладення, клавіатура Tab+Enter виводить наперед — для `quest-board` і кібер-картки (спільний spec). Наявні specs «Дошки» зелені без змін логіки.
- [ ] Specs: обмежена (restricted) картка; довга назва 120 символів / нік 40 / усі бейджі — без горизонтального переповнення (**RF 5**); кольори неону — 6 варіантів, сусідні id різні.
- [ ] Браузер: пошук у «Нічному місті» 1440 і 375, порівняння з `cyber-ac-hybrid.png`; «Дошка» без змін. **Commit** `feat(frontend): cyber game card and shared cover attachment`

### Task 3: Дизайн «Неонові вивіски»

**Files:** Create `theming/themes/neon-signs/{neon-signs.less, neon-signs-material.scss}` (бандл `theme-neon-signs`), шрифт M PLUS Rounded 1c; при потребі — декоративні елементи в спільних компонентах кібер-родини (без зміни контрактів).

- За `cyber-a-neon.*`: мокра цегляна стіна (CSS), картка — світловий короб з неоновою рамкою свого кольору й плямою світла на стіні, ціна — неонова табличка, «Підходить вашому розкладу» — зелена вивіска, обкладинка — паперовий постер на скотчі, заголовок сторінки — неонова вивіска з «напівмертвою» блимаючою літерою (лише без reduced-motion; текст лишається доступним як звичайний текст).
- [ ] Браузер: пошук, «Мої ігри», сторінка гри, форма гри, налаштування — 1440 і 375; скріншоти в `docs/design-concepts/cyber/neon-signs/`. Specs компонентів кібер-родини зелені. **Commit** `feat(frontend): neon signs theme`

### Task 4: Дизайн «Голо-ринок»

**Files:** Create `theming/themes/holo-market/{holo-market.less, holo-market-material.scss}` (бандл `theme-holo-market`), шрифт Jura.

- За `cyber-c-holo.*`: розмитий фон нічного ринку з українськими вивісками (CSS/inline SVG, легкий за вагою), картки — напівпрозорі голо-панелі зі зрізаними кутами, ледь помітні сканлайни поза текстом, хроматичний край, проєктор зі світловим конусом під карткою; обкладинка — ч/б голо-прев'ю, кольорове й наперед при наведенні; рядок статистики під заголовком сторінки — лише якщо дані вже є в наявних DTO, інакше не додавати.
- [ ] Браузер: ті самі сторінки 1440 і 375; скріншоти в `docs/design-concepts/cyber/holo-market/`. **Commit** `feat(frontend): holo market theme`

### Task 5: Увесь сайт, мініатюри, фінальна перевірка

**Files:** `frontend/public/themes/{neon-signs,holo-market,night-city}.png` (скріншоти реальних сторінок пошуку, той самий розмір, що `quest-board.png`); дрібні виправлення стилів сторінок для кібер-дизайнів; `docs/QA-features.md` (дизайни на вибір); `docs/superpowers/backlog.md`.

- [ ] Браузер, кожен кібер-дизайн, desktop + mobile: всі маршрути `app.routes.ts` і вкладки `/admin` — немає світлих плям, нечитабельного тексту, невидимих меж полів, зламаних меню/діалогів Material (**RF 4**). Перемикач «Вигляд» видно звичайному користувачу; вибір зберігається після перезавантаження; гість — «Дошка».
- [ ] `npm test && npm run typecheck && npm run lint && npm run build -w frontend` зелені; у мережевій панелі — лише бандл обраного дизайну. **Commit** `feat(frontend): cyber themes across the site and previews`
