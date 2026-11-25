# НРІ Асистент — План 8: дизайни на вибір і «Дошка оголошень»

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сайт отримує систему дизайнів зі слотами й лінивим завантаженням, основний дизайн «Дошка оголошень» на всіх сторінках і «Класичний» (теперішній) лише для власника.

**Architecture:** `frontend/src/app/theming/` — реєстр дизайнів, `ThemeService` і хост `<nri-slot>`; кожен дизайн живе в `theming/themes/<id>/` (слоти + стилі + Material), вантажиться лінивим чанком. Сторінки, форми й логіка спільні; слоти лише показують дані й віддають події. Вибір дизайну — `users.ui_theme`, чинний дизайн з урахуванням ролі віддає `/api/me`.

**Tech Stack:** як у Плані 7 (Angular 22 zoneless, LESS + один Sass на дизайн для Material, Express, Drizzle/MySQL, vitest). Нові dev-залежності: шрифти локально (`@fontsource/kurale`, `@fontsource/literata`, `@fontsource/cormorant-garamond`, `@fontsource/lora`, `material-symbols` або еквівалент), `stylelint` + `stylelint-config-standard-less` (якщо ще немає).

**Spec:** `docs/superpowers/specs/2026-11-25-themes-quest-board-design.md` (затверджено). Візуальний еталон: `docs/design-concepts/2-quest-board.html` / `.png`.

## Global Constraints

- `ThemeId = 'quest-board' | 'classic'`; за замовчуванням `quest-board`; `classic` — лише роль `owner`; гості — завжди `quest-board`.
- Дизайн не обмежує функціонал: однакові сторінки, дії, поля, тексти в усіх дизайнах; кожен слот має однаковий контракт inputs/outputs для всіх дизайнів.
- Логіка (що показати, які дії доступні, тексти бейджів) — у спільних функціях/сервісах, не в компонентах слотів.
- Браузер вантажить компоненти й стилі лише обраного дизайну.
- Контраст тексту ≥ 4.5:1 (дрібний), ≥ 3:1 (великий/іконки); поворот карток — лише ширше 600px і без `prefers-reduced-motion`; поля вводу ніколи не повернуті й не «рвані».
- Шрифти й іконки — локальні (без fonts.googleapis.com); «Дошка»: Kurale (заголовки) + Literata (текст); «Класичний»: Cormorant Garamond + Lora.
- Без мигання: інлайн-скрипт в `index.html` застосовує кешований у `localStorage` дизайн (`data-theme`, `color-scheme`, `<link>` стилів) до старту застосунку; кеш — лише підказка.
- Компоненти поза `styles/themes/` і `theming/themes/` не містять hex-кольорів (stylelint `color-no-hex`).
- Як у попередніх планах: компоненти .ts/.html/.less; тексти `uk.json`; контракти в `@nri/shared`; права на бекенді; prettier лише змінені файли; усі перевірки зелені; бандл початкового завантаження не росте понад наявний бюджет.

## Review Focus

1. **Втрата ролі власника:** після передачі прав колишній власник із збереженим `classic` бачить «Дошку», а новий власник може обрати `classic`. Тест — Task 1.
2. **Підміна з клієнта:** `localStorage`/ручний `data-theme='classic'` у не-власника — `ThemeService` після `/me` повертає `quest-board`, і стилі «Класичного» не лишаються підключеними. Тест — Task 2.
3. **Збій завантаження чанку дизайну** (мережа): сторінка лишається робочою — показується спільний резервний слот, а не порожнеча. Тест — Task 2.
4. **Функціональний паритет:** у слоті картки гри/рядка моєї гри «Дошки» доступні ті самі дії й позначки, що в «Класичному» (заявка, вік, розклад, статус, «мертва/підозріла», дії майстра). Тест — Task 3 (спільний spec-набір проганяється для обох дизайнів).
5. **Довгі дані:** довга назва гри, нік, 10+ бейджів, відсутня обкладинка, 0 оцінок — у «Дошці» не ламають розкладку й не ховають кнопки. Тест — Task 3.

---

### Task 1: Збереження вибору дизайну (бекенд + shared)

**Files:** міграція `backend/src/db/migrations/0028_plan8_ui_theme.sql` (`users.ui_theme varchar(32) NULL`) + схема; Create `shared/src/contracts/theme.ts`; Modify `shared/src/contracts/me.ts`, `backend/src/users/users.routes.ts`/`users.service.ts` (або де формується `/api/me`), tests.

**Interfaces:**
- Produces (shared): `THEME_IDS = ['quest-board','classic'] as const`, `type ThemeId`, `DEFAULT_THEME: ThemeId = 'quest-board'`, `themeAccess: Record<ThemeId, 'everyone'|'owner'>`, `availableThemes(role: UserRole): ThemeId[]`, `resolveTheme(stored: string|null, role: UserRole): ThemeId`; `MeDto.uiTheme: ThemeId`, `MeDto.availableThemes: ThemeId[]`; `UpdateThemeRequest { theme: ThemeId }`.
- Produces (API): `PATCH /api/me/theme` → 200 `MeDto`; 400 `VALIDATION` на невідомий id; 403 `THEME_NOT_AVAILABLE` на недоступний ролі; роль перечитується з БД.

- [ ] Тести shared: `resolveTheme(null,'user') === 'quest-board'`, `resolveTheme('classic','user') === 'quest-board'`, `resolveTheme('classic','owner') === 'classic'`, `resolveTheme('bogus','owner') === 'quest-board'`, `availableThemes('admin')` = `['quest-board']`, `availableThemes('owner')` містить обидва.
- [ ] Тести бекенду: PATCH зберігає й `/api/me` віддає `uiTheme`; не-власник з `classic` → 403; невідомий → 400; (**RF 1**) власник обрав `classic` → передача прав → колишній власник отримує `uiTheme: 'quest-board'` (значення в БД лишається), новий власник може обрати `classic`; гість (без сесії) → 401.
- [ ] Реалізація, `npm test -w shared -w backend` зелені. **Commit** `feat(backend): user ui theme preference`

### Task 2: Ядро системи дизайнів + «Класичний» як перший дизайн (фронтенд)

**Files:** Create `frontend/src/app/theming/{theme.registry.ts, theme.service.ts, slot.ts (nri-slot), slots.ts (контракти), fallback/*}`, `frontend/src/app/theming/themes/classic/{slots.ts, *.component.*, classic.less, classic-material.scss}`; Modify `index.html` (інлайн-скрипт, локальні шрифти й Material Symbols замість Google), `angular.json` (прибрати `material-dark.scss`/`dark.less` з глобальних стилів; бандли дизайнів `inject: false`; структурний Material лишається глобальним), `styles.less`, `styles/themes/*` (`dark` → `classic`), `app.config.ts` (ініціалізатор: `AuthStore.load()` → `ThemeService.init()`), shell/game-card/my-games/заголовки сторінок/порожні стани — перевести на `<nri-slot>`; stylelint-конфіг і скрипт `lint:styles` у `npm run lint`; specs.

**Interfaces:**
- Consumes: Task 1 `ThemeId`, `resolveTheme`, `MeDto.uiTheme/availableThemes`, `PATCH /api/me/theme`.
- Produces:
  - `ThemeDefinition { id: ThemeId; labelKey: string; preview: string /* public/themes/<id>.png */; colorScheme: 'light'|'dark'; styleHref: string /* версійований ?v=<build> */; loadSlots: () => Promise<ThemeSlots> }`; `THEMES: Record<ThemeId, ThemeDefinition>`.
  - `ThemeSlots = Record<SlotName, Type<unknown>>`; `SlotName = 'shell' | 'game-card' | 'my-game-item' | 'page-header' | 'empty-state' | 'badge' | 'gm-signature'`; для кожного — інтерфейс inputs/outputs у `slots.ts` (напр. `GameCardSlot { game: GameCardVm; returnTo: string; apply: OutputEmitterRef<void> }`).
  - `ThemeService`: `theme: Signal<ThemeId>`, `available: Signal<ThemeId[]>`, `slots: Signal<ThemeSlots|null>`, `init(): Promise<void>`, `select(id: ThemeId): Promise<void>` (PATCH + застосування без перезавантаження), кеш у `localStorage['nri.theme']`.
  - `<nri-slot [name]="SlotName" [inputs]="Record<string, unknown>" (output)…>` — рендер через `ViewContainerRef.createComponent` з `inputBinding`/`outputBinding`; поки слоти не завантажились або чанк упав — компонент з `theming/fallback/` (простий, без декору, той самий контракт).
  - View-model функції (спільні): `toGameCardVm(game: GameSearchItemDto, me: MeDto|null): GameCardVm`, `toMyGameItemVm(game: MyGameDto): MyGameItemVm` — усі обчислення бейджів/дій тут.
- [ ] Specs: `ThemeService` — не-власник з `localStorage='classic'` після init → `quest-board` і `data-theme='quest-board'`, `<link>` «Класичного» видалено (**RF 2**); `select` міняє `data-theme` і `<link>` без перезавантаження; `nri-slot` рендерить компонент дизайну з inputs і пробрасує outputs; при відхиленому `loadSlots` — резервний компонент і сторінка працює (**RF 3**); view-model функції покрито тестами з наявних spec-ів картки/«Моїх ігор».
- [ ] Поки «Дошки» ще немає — реєстр має `quest-board` як тимчасовий аліас на слоти «Класичного» (Task 3 замінює); візуально сайт для власника з `classic` не змінився (порівняти скріншот пошуку й «Моїх ігор» до/після).
- [ ] `npm test -w frontend && npm run lint && npm run build -w frontend` зелені; initial-бандл не більший за поточний. **Commit** `feat(frontend): theme system with slots and classic theme`

### Task 3: Дизайн «Дошка оголошень» — токени, Material, слоти

**Files:** Create `frontend/src/app/theming/themes/quest-board/{slots.ts, quest-board.less, quest-board-material.scss, shell/*, game-card/*, my-game-item/*, page-header/*, empty-state/*, badge/*, gm-signature/*}`; локальні шрифти Kurale + Literata; Modify реєстр (прибрати тимчасовий аліас), `uk.json`; specs.

**Interfaces:** Consumes Task 2 `SlotName`-контракти, view-model типи, `ThemeDefinition`. Produces нічого нового для інших тасків, крім заповненого реєстру.

- Палітра з концепту: дерево `#3A2718`/`#2C1D12`, пергамент `#EADFC4`, чорнило `#2B1E14`, латунь `#C9A227`, сургуч `#8E1F1A`, мох `#4E5B31`; значення для `--nri-*` підібрати з контрастом за Global Constraints (перевірити розрахунком у коментарі, як у `dark.less`).
- `shell`: дерев'яна планка-шапка, навігація, дзвіночок, меню користувача, підвал; фон — дерев'яна стіна CSS-градієнтами; мобільне меню.
- `game-card`: приколоте оголошення (шпилька, «рваний» край через `clip-path`, поворот з набору ±1.6° за індексом, лише > 600px і без reduced-motion), стрічка «твій розклад/частково», сургучна печатка з ціною або «без плати», блок «Коли/Де/Місця», підпис майстра з рейтингом, вікові/статусні бейджі, обмежена (restricted) версія.
- `my-game-item`: оголошення без повороту з діями майстра й позначками «давно не проводилась / мертва / підозріла».
- `page-header`, `empty-state`, `badge`, `gm-signature` — у тій самій мові.
- [ ] Specs (**RF 4**): спільний набір перевірок контракту `game-card` і `my-game-item` проганяється для обох дизайнів (`describe.each(['classic','quest-board'])`): видно назву, систему, розклад, місця, ціну, вік, статус, кнопку/посилання заявки, підпис майстра; у `my-game-item` — усі дії майстра й позначки.
- [ ] Specs (**RF 5**): довга назва (120 символів), нік 40 символів, відсутня обкладинка, `rating: null`, усі бейджі разом — немає горизонтального переповнення (`scrollWidth <= clientWidth`) і кнопка дії видима.
- [ ] Перевірка в браузері (dev-сервер): пошук, «Мої ігри», профіль — скріншоти desktop 1440 і mobile 375. **Commit** `feat(frontend): quest board theme`

### Task 4: «Дошка» на всьому сайті + перемикач «Вигляд»

**Files:** Modify сторінки й діалоги, де токенів «Дошки» недостатньо (форми гри, сторінка гри, заявки, календар, нотатки, оцінки, сповіщення, налаштування, вхід/профіль, адмінка — таблиці й вкладки, банери санкцій/оновлення, екран бану); `account-settings` — розділ «Вигляд»; `public/themes/{quest-board,classic}.png`; `uk.json`; specs.

**Interfaces:** Consumes `ThemeService.available/theme/select`, `THEMES[id].labelKey/preview`.

- Пергаментні поверхні без повороту для форм, таблиць, діалогів; Material-компоненти — через `--mat-sys-*` дизайну; жодних hex у компонентах.
- Розділ «Вигляд»: картки доступних дизайнів з мініатюрою й назвою, вибраний позначений; показується лише коли `available().length > 1`; вибір застосовується одразу; помилка PATCH — повідомлення й повернення попереднього.
- [ ] Specs: розділ прихований для `available = ['quest-board']`; видимий для власника; клік викликає `select('classic')`; помилка → відкат і повідомлення.
- [ ] Прохід у браузері кожного маршруту з `app.routes.ts` і вкладок `/admin` у «Дошці» (desktop + mobile): немає нечитабельного тексту, «білих плям» від старих кольорів, зламаних діалогів/меню Material. Зафіксувати скріншоти ключових сторінок у `docs/design-concepts/plan-8/`.
- [ ] `npm test && npm run typecheck && npm run lint && npm run build -w frontend` зелені. **Commit** `feat(frontend): quest board across the site and theme picker`

### Task 5: Фінальна перевірка

- [ ] `npm test && npm run typecheck && npm run lint && npm run build -w frontend`; `docker build` фронтенд-образу (шрифти/стилі дизайнів потрапляють в образ, nginx віддає бандли дизайнів).
- [ ] Браузер: перше відкриття гостем без мигання; власник перемикає «Дошка» ↔ «Класичний», перезавантаження зберігає вибір; звичайний користувач перемикача не бачить; у мережевій панелі вантажиться чанк лише обраного дизайну.
- [ ] `docs/superpowers/backlog.md` — «Після Плану 8»: хеш інлайн-скрипта для майбутнього `script-src` у CSP; інші концепти як дизайни (аркуш, кубики, мапа, ліхтар); мапа/афіша як функції. **Commit** `docs: plan 8 verification and backlog`
