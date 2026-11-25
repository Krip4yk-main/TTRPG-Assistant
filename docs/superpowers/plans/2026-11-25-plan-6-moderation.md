# НРІ Асистент — План 6: Модерація

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Адміністрація розглядає скарги, накладає строкові санкції й бани, розглядає апеляції, модерує відгуки, керує ролями; ухилення від бану закрито; усе — з журналом дій і в розділі `/admin`.

**Architecture:** Новий модуль `backend/src/moderation/` (права за роллю, скарги, санкції, апеляції, модерація оцінок, ролі, журнал). Глобальний бан — тип санкції, що також виставляє наявні `users.is_banned`/`ban_epoch` (вхід і токен апеляції з Плану 3 лишаються). Обмеження перевіряються в місцях дії (подача заявки, створення/редагування гри). Строки знімає рекурентна задача планувальника (План 4). Фронт: кнопки «Поскаржитися», повідомлення про санкцію з апеляцією, лениво завантажуваний розділ `/admin`.

**Tech Stack:** як у Плані 5. Нових залежностей немає.

**Spec:** `docs/superpowers/specs/2026-11-25-plan-6-moderation-design.md` (затверджено) + `docs/superpowers/specs/2026-11-24-nri-assistant-design.md` §2, §4, §7.

## Global Constraints

- Ролі: `user < moderator < admin < owner`. Матриця прав — як у таблиці дизайну; дія проти людини з рівною чи вищою роллю → 403 `MODERATION_FORBIDDEN`.
- Причини скарг: `scam`, `harassment`, `no_show`, `agreement_violation`, `inappropriate_content`, `other`; текст ≤ 2000 (trim).
- Типи санкцій: `warning`, `application_limit` (≤ 1 заявки в статусі `pending`), `no_paid_apply`, `no_paid_create`, `global_ban`. Строк: `7d`, `30d`, `90d`, `permanent`.
- Анонімність: ні API, ні сповіщення не розкривають скаржника тому, на кого скаржились, і оцінювача — оцінюваному.
- Кожна дія персоналу пише рядок у `moderation_log` (хто, дія, об'єкт, причина, час), лише додавання.
- Як у попередніх планах: компоненти .ts/.html/.less; тексти — `uk.json` фронту й бота; контракти в `@nri/shared`; права на бекенді; UTC; prettier лише змінені файли; `npm test`, `npm run typecheck`, `npm run lint`, `npm run build -w frontend` зелені.

## Review Focus

1. **Ескалація прав:** модератор не може глобально забанити, змінити роль, покарати адміна/модератора; адмін не може зробити когось адміном. Тест — Task 1/4.
2. **Витік скаржника/оцінювача:** відповідь «скаргу розглянуто», картка користувача для модератора, перерахунок після анулювання — без ідентичності скаржника для того, на кого скаржились, і без оцінювача. Тест — Task 2/4.
3. **Ухилення від бану:** відв'язав Telegram, потім отримав бан → повторна реєстрація тим самим Telegram — `IDENTITY_BANNED`; розбан — знову можна. Тест — Task 3.
4. **Строки:** санкція на 7 днів знімається задачею; обмеження діє до останньої мілісекунди строку; дострокове зняття працює. Тест — Task 3.
5. **Бан і чужі дані:** бан майстра скасовує його активні ігри (гравцям — сповіщення про скасування), менша санкція нічого наявного не змінює. Тест — Task 3.

---

### Task 1: Схема, контракти, права

**Files:** Create `backend/src/db/schema/moderation.ts` (+ export), міграція `0023_plan6_moderation.sql`; Create `backend/src/moderation/permissions.ts`; Create `shared/src/contracts/moderation.ts`; Modify `shared/src/errors.ts` + `frontend uk.json errors.*`; `backend/test/helpers.ts` TABLES; tests.

**Interfaces — Produces:**
- `complaints(id, reporter_id FK users cascade, target_user_id FK NULL, target_game_id FK NULL, reason enum, message varchar(2000), status enum('new','dismissed','actioned'), resolved_by FK NULL, resolved_at NULL, sanction_id NULL, created_at datetime(3))`; CHECK рівно одна ціль; індекс `(status, id)`.
- `sanctions(id, user_id FK cascade, type enum, reason varchar(2000), imposed_by FK, starts_at datetime(3), ends_at datetime(3) NULL /*permanent*/, lifted_at NULL, lifted_by NULL, complaint_id NULL, created_at)`; індекс `(user_id, type, ends_at)`.
- `sanction_appeals(id, sanction_id FK cascade UNIQUE, user_id, message varchar(2000), status enum('pending','accepted','rejected'), decided_by NULL, decided_at NULL, decision_note varchar(2000) NULL, created_at)`; міграція переносить `ban_appeals` (для кожного забаненого користувача — санкція `global_ban permanent` з `imposed_by` = власник/NULL, апеляція прив'язується); `ban_appeals` лишається до кінця плану (видалення — Task 7).
- `moderation_log(id, actor_id, action varchar(64), target_type varchar(32), target_id bigint, reason varchar(2000) NULL, meta json NULL, created_at datetime(3))`.
- `identity_tombstones.user_id` (NULL, FK set null) + індекс.
- `ratings.moderated enum('none','text_hidden','cancelled') default 'none'`, `moderated_by NULL`, `moderated_at NULL`.
- `permissions.ts`: `ROLE_RANK`, `requireStaff(min: Role)` middleware (403 `MODERATION_FORBIDDEN`), `assertCanActOn(actorRole, targetRole)`, `can(actorRole, action: StaffAction): boolean` за матрицею дизайну.
- shared: `COMPLAINT_REASONS`, `SANCTION_TYPES`, `SANCTION_DURATIONS`, `complaintInputSchema`, `sanctionInputSchema`, `appealInputSchema` (для санкцій), DTO для адмінки (`ComplaintDto`, `SanctionDto`, `AppealDto`, `AdminUserDto`, `ModerationLogDto`, `MySanctionDto`), нові коди помилок: `MODERATION_FORBIDDEN`, `COMPLAINT_NOT_ALLOWED`, `SANCTION_ACTIVE` (заборонена дія; `details.type`, `details.endsAt`), `APPEAL_EXISTS` (вже є — перевикористати), `OWNER_TRANSFER_INVALID`.
- [ ] Тести: матриця прав (кожна клітинка), `assertCanActOn` (рівний/вищий → 403), схеми shared, міграція переносить наявні `ban_appeals`. **Commit** `feat: moderation schema, contracts and permissions`

### Task 2: Скарги й щоденне зведення

**Files:** Create `backend/src/moderation/{complaints.service.ts, complaints.routes.ts, digest.ts}`; Modify notifications (категорія `moderation`, типи `moderation.digest`, `complaint.resolved`), `jobs/index.ts`; бот і фронт `uk.json`; tests.

**Interfaces:** `POST /api/complaints {targetUserId?: publicId, targetGameId?: number, reason, message}` (auth, requireActive) — право на людину: спільна гра (будь-коли, зокрема колишні), майстер гри, на яку ціль подавала заявку, ціль подавала заявку на твою гру; на гру — будь-хто, якщо гра видима йому; себе — ні (403 `COMPLAINT_NOT_ALLOWED`). `GET /api/admin/complaints?status=&cursor` (staff; скарги на персонал — лише адмін (на модератора) і власник; на власника — лише власник), `POST /api/admin/complaints/:id/dismiss {note?}`, `POST /api/admin/complaints/:id/action {sanction: sanctionInput}` (створює санкцію через Task 3, статус `actioned`); скаржнику — `complaint.resolved` без подробиць. Дайджест: задача `moderation.digest` `dailyAtUtc` відповідно 09:00 Europe/Kyiv (обчислювати UTC з урахуванням літнього часу — щоденна задача о 06:00 і 07:00 UTC з перевіркою локального часу, або власний розрахунок; виконавець обирає й тестує DST) — сповіщення staff з кількістю нових; без сповіщення, якщо 0.
- [ ] Тести: хто може скаржитись (кожен випадок), анонімність (картка цілі не має скаржника), видимість черги персоналу, dismiss/action пишуть журнал і сповіщають скаржника, дайджест (0 → нічого, повтор → без дублів). **Commit** `feat(backend): complaints and daily digest`

### Task 3: Санкції, бан, строки, ухилення

**Files:** Create `backend/src/moderation/{sanctions.service.ts, sanctions.routes.ts, sanctions.enforce.ts, sanctions.jobs.ts}`; Modify `applications.service.ts` (подача), `games.service.ts` (створення/редагування ціни), `users.service.ts` (`banUser` → через санкцію; винести каскад виходу/скасування з `deleteAccount` у спільну функцію; надгробок на кожне відв'язування й видалення з `user_id`), auth (реєстрація/прив'язка перевіряє банований надгробок), notifications (`sanction.imposed`, `sanction.lifted`); tests.

**Interfaces:** `imposeSanction(deps, actorId, userId, input, complaintId?) → SanctionDto` (права, `assertCanActOn`, журнал, сповіщення покараному з типом/причиною/кінцем; `global_ban` — `is_banned=1`, `ban_epoch+1`, відкликання сесій, каскад: скасування активних ігор майстра, відкликання заявок, вихід з ігор із причиною `banned_by_admin`, позначення надгробків); `liftSanction(deps, actorId, sanctionId, note)` (бан — `is_banned=0`, зняти позначки надгробків); задача `moderation.expire` щохвилини/5 хв знімає прострочені (система як актор); `activeSanctions(q, userId, now) → Set<SanctionType>`; перевірки: подача заявки — `application_limit` (≥ 1 pending → 409 `SANCTION_ACTIVE`), `no_paid_apply` (гра з `priceUah > 0`); створення/редагування гри — `no_paid_create` (нова платна або 0→платна); `GET /api/me/sanctions` (мої активні з причиною й кінцем); `POST /api/admin/users/:publicId/sanctions`, `POST /api/admin/sanctions/:id/lift`.
- [ ] Тести: (**RF 3**) відв'язування → бан → реєстрація тим самим Telegram → `IDENTITY_BANNED`; розбан → можна; бан видаленого акаунта позначає надгробки; (**RF 4**) межі строку, задача знімає, дострокове зняття; (**RF 5**) бан майстра скасовує ігри й сповіщає гравців, бан гравця відкликає заявки/виводить з ігор; менші санкції не змінюють наявного; кожне обмеження блокує нову дію з `SANCTION_ACTIVE`; (**RF 1**) модератор не може `global_ban`. **Commit** `feat(backend): sanctions, global ban cascade, ban evasion`

### Task 4: Апеляції, модерація оцінок, ролі, власник, журнал

**Files:** Create `backend/src/moderation/{appeals.service.ts, ratings-moderation.ts, roles.service.ts, log.routes.ts, admin.routes.ts}`; Modify `backend/src/appeals/*` (апеляція на бан → `sanction_appeals`), `backend/src/ratings/*` (виключати `cancelled`, `text_hidden` ховати; `republish(tx, userId, role)` — перерахунок одразу, < 5 одиниць → сховати); tests.

**Interfaces:** `POST /api/me/sanctions/:id/appeal {message}` (одна на санкцію; 409 `APPEAL_EXISTS`); бан — через наявний токен-ендпоінт, тепер пише в `sanction_appeals`; `GET /api/admin/appeals?status=`, `POST /api/admin/appeals/:id/decide {accept: boolean, note?}` (accept → `liftSanction`; сповіщення `appeal.decided`; забанений бачить статус на екрані бану через `details.appealStatus`); `GET /api/admin/ratings?filter=new|commented` (з текстами, без розкриття оцінювача іншим, але персонал бачить ніки обох), `POST /api/admin/ratings/:id/hide-text {reason}`, `POST /api/admin/ratings/:id/cancel {reason}`; `PUT /api/admin/users/:publicId/role {role: 'user'|'moderator'|'admin'}` (матриця), `POST /api/admin/owner/transfer {toPublicId, confirmNickname}` (лише чинному адміну; колишній власник → admin); `GET /api/admin/users?q=` і `GET /api/admin/users/:publicId` (`AdminUserDto`: ролі, санкції, скарги на людину без скаржників для модераторів), `GET /api/admin/log?cursor` (адмін/власник).
- [ ] Тести: апеляція одна на санкцію; рішення знімає санкцію й пише журнал; анулювання → рейтинг перераховано одразу (і сховано при < 5), автор не сповіщений; приховування тексту; ролі (RF 1 — усі заборонені комбінації); передача власника (не адміну → 400, неправильний нік → 400, успіх → ролі помінялись, видалення колишнього власника дозволене); журнал має кожну дію. **Commit** `feat(backend): appeals, rating moderation, roles and audit log`

### Task 5: Фронтенд — скарги, санкції користувача, апеляції

**Files:** `frontend/src/app/core/moderation/*` (api), `features/moderation/complaint-dialog/*` (кнопка «Поскаржитися» на профілі — якщо `viewer.canComplain` — і на сторінці гри), `features/moderation/my-sanctions/*` (банер/сторінка «Обмеження акаунта» з причиною, кінцем, кнопкою «Оскаржити» й формою), обробка `SANCTION_ACTIVE` у формах заявки/гри (зрозуміле пояснення з датою), екран бану — статус апеляції; `uk.json`; specs. Бекенд: поле `viewer.canComplain` у профілі (додати в Task 5, якщо не зроблено в Task 2).
- [ ] Specs: діалог скарги (причина обов'язкова, ліміт тексту, 403), банер санкцій і апеляція (одна, 409), пояснення `SANCTION_ACTIVE`, статус апеляції на екрані бану. **Commit** `feat(frontend): complaints, sanctions notice and appeals`

### Task 6: Фронтенд — розділ `/admin`

**Files:** `features/admin/*` (ленивий маршрут `/admin`, guard за роллю ≥ moderator; вкладки «Скарги», «Користувачі», «Апеляції», «Відгуки», «Ролі» (адмін+), «Журнал» (адмін+)); посилання «Адмінка» в меню для персоналу; `uk.json`; specs.
- Скарги: список з фільтром статусу, картка з текстом і ціллю, дії «Відхилити» / «Вжити заходів» (діалог санкції: тип, строк, причина; бан — лише адмін+).
- Користувачі: пошук, картка (роль, активні/минулі санкції, скарги на людину), накласти/зняти санкцію.
- Апеляції: черга, рішення з приміткою.
- Відгуки: черга з текстами, «Сховати текст» / «Анулювати оцінку» з причиною й підтвердженням.
- Ролі: призначити/зняти модератора (адмін+), адміна (власник); передача прав власника з введенням ніку.
- Журнал: стрічка з пагінацією.
- [ ] Specs: guard (user → немає доступу), видимість вкладок за роллю, діалог санкції (бан недоступний модератору), підтвердження анулювання й передачі прав. Бандл: початковий не росте (лениве завантаження). **Commit** `feat(frontend): admin section`

### Task 7: Фінальна перевірка

- [ ] Прибрати `ban_appeals` (міграція видалення після перенесення), `npm test && npm run typecheck && npm run lint && npm run build -w frontend`, `docker build` трьох образів.
- [ ] Ручна перевірка в браузері: скарга гравця → у модератора в черзі → санкція → покараний бачить банер і оскаржує → адмін приймає апеляцію; бан майстра → ігри скасовано; відв'язування + бан → повторний вхід заблоковано; передача прав власника.
- [ ] Оновити `docs/superpowers/backlog.md`. **Commit** `docs: plan 6 verification and backlog`
