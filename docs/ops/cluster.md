# Кластер: образи, налаштування, розкатка (для Кейна)

Документ описує, що саме кластер бере з цього репозиторію й що треба налаштувати на його боці. Усі налаштування серверів — **лише в `.env`-файлах** (секрети — через ваш sealing); змінних репозиторію GitHub немає.

## Гілки й середовища

| Гілка  | Середовище        | Теги образів | Файл дайджестів (гілка `deploy`) |
| ------ | ----------------- | ------------ | -------------------------------- |
| `beta` | dev-кластер, бета | `beta-<sha>` | `deploy/images.yaml`             |
| `main` | prod              | `prod-<sha>` | `deploy/images-prod.yaml`        |

Увесь код потрапляє в `beta`, у `main` — пізніше з беті. Обидві гілки збирає один воркфлоу `.github/workflows/deploy.yml`.
Фронтенд у двох гілках **зібраний по-різному** (банер «Тестове середовище», прихований `/login/dev` лише на беті), тому образи беті й проду не взаємозамінні.

## Образи

Усі: `ghcr.io/krip4yk-main/ttrpg-<частина>`, пакети публічні. Беріть образи **лише за дайджестом** (`image@sha256:…`) з файлу дайджестів; теги (`beta-<sha>`, `prod-<sha>`) — для людей.

| Образ            | Що робить                                                                                       | Порт | Потрібен `.env`                                        |
| ---------------- | ----------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------ |
| `ttrpg-backend`  | API + воркер джобів (один процес), WebSocket `/socket.io`; той самий образ — для Job-а міграцій | 3000 | [`backend/.env.template`](../../backend/.env.template) |
| `ttrpg-bot`      | Telegram-бот (long polling, порти не слухає); ходить у бекенд по внутрішньому API               | —    | [`bot/.env.template`](../../bot/.env.template)         |
| `ttrpg-frontend` | nginx зі статикою SPA (`nginx-unprivileged`); налаштування фронтенду — з бекенду                | 8080 | не потрібен (змінні не потрібні, див. нижче)           |
| `ttrpg-backup`   | планувальник бекапів БД (довго працюючий процес); див. «Бекапи»                                 | —    | `BACKUP_*` з [`.env.template`](../../.env.template)    |

Усі процеси працюють не від root. Запускайте з init-процесом (`--init` / tini), щоб сигнали та зомбі оброблялися коректно.

## Файли дайджестів

Гілка `deploy` містить лише ці файли; робот пише їх, у `beta`/`main` вони не потрапляють. Формат однаковий (рівно чотири ключі):

```
# built from commit <sha>
backend: sha256:<64 hex>
bot: sha256:<64 hex>
frontend: sha256:<64 hex>
backup: sha256:<64 hex>
```

Бета пише лише `deploy/images.yaml`, прод — лише `deploy/images-prod.yaml`. Ключ `backup:` новий — потрібен окремий сервіс (див. «Бекапи»). Поки прод-кластер не читає `images-prod.yaml`, пуш у `main` просто нічого не змінює для нього.

Відкат: перезапустіть run воркфлоу потрібного коміту — він збере той коміт знову й запише його дайджести. Увага: якщо після цього в ту саму гілку надійшов новіший пуш, старий run буде скасовано (`cancel-in-progress`); тоді відкатуйте комітом у гілці або повторіть run, коли нових пушів немає.

## Налаштування: лише `.env`

Усе, що відрізняється між серверами (ім'я бота, провайдери входу, секрети, бекапи), — у `.env` відповідного сервісу. У збірці образів — лише середовище фронтенду, воно береться з гілки.

- **backend** — [`backend/.env.template`](../../backend/.env.template). Обов'язково: `NODE_ENV=production`, `DEPLOY_ENV=dev` (бета) або `prod`, `PUBLIC_BASE_URL=https://…` (інакше бекенд не стартує), `DATABASE_URL`, `REDIS_URL`, `IDENTITY_PEPPER`, `INTERNAL_API_KEY`, `TELEGRAM_BOT_TOKEN`/`TELEGRAM_BOT_USERNAME`, `TRUST_PROXY`, `OWNER_TELEGRAM_ID` (див. [deploy.md](deploy.md#перший-власник-платформи)). Необов'язково: `GOOGLE_*`, `DISCORD_*` (кнопки входу з'являться самі), `CALENDAR_IMPORT_KEY`.
- **bot** — [`bot/.env.template`](../../bot/.env.template): `TELEGRAM_BOT_TOKEN`, `BACKEND_INTERNAL_URL` (напр. `http://<сервіс-backend>:3000/api/internal`), `INTERNAL_API_KEY` дослівно як у backend, `PUBLIC_BASE_URL`.
- **frontend** — `.env` і змінні не потрібні: `DEPLOY_ENV` образ бере з гілки під час збірки (`dev` на беті — nginx додає `X-Robots-Tag: noindex, nofollow`; `prod` на проді). Перевизначати змінною `DEPLOY_ENV` у контейнері необов'язково.
- **backup** — [`.env.template`](../../.env.template) (розділ `BACKUP_*`): див. «Бекапи».
- **Job міграцій** — той самий `.env`, що й backend.

Токени, OAuth-застосунки та `IDENTITY_PEPPER`/`INTERNAL_API_KEY`/`CALENDAR_IMPORT_KEY` для беті й проду — окремі ([environments.md](environments.md)). `IDENTITY_PEPPER` після запуску не змінювати.

### Dev-вхід на беті

У `backend/.env` беті: `DEV_LOGIN_ENABLED=true`, `DEV_LOGIN_CODES=мітка:код,…`, `TRUST_PROXY>=1`. Фронтенд беті має сторінку `/login/dev` (збірка з гілки `beta`); вхід вимикається одним рядком `DEV_LOGIN_ENABLED=false` і перезапуском бекенду. На проді ці змінні задавати не можна — бекенд не стартує. Докладно: [environments.md](environments.md#dev-вхід-за-середовищами).

## Мережа й проби

- **Бекенд (3000):** liveness — `GET /api/health/live` (200, поки процес живий); readiness — `GET /api/health` (MySQL, Redis, воркер; 200 або 503).
- **Фронтенд (8080):** проба — `GET /` (200).
- **Ingress / reverse proxy:** один origin; `/api`, `/socket.io`, `/sitemap.xml`, `/robots.txt` → backend:3000; решта → frontend:8080.
- **WebSocket `/socket.io`:** потрібні заголовки upgrade (`Upgrade`, `Connection`) і довгі таймаути читання. Бекенд використовує Redis-адаптер Socket.IO (`@socket.io/redis-adapter`), тож кілька реплік працюють разом. Клієнт Socket.IO стартує з long-polling і потім переходить на WebSocket (транспорти не обмежені), тому **при кількох репліках backend потрібні sticky sessions** (за cookie) на `/socket.io`; Redis-адаптер лише розсилає події між репліками. З однією реплікою нічого додаткового не потрібно.
- **`/api/internal/*` закрийте назовні** (404/403 в ingress): бот ходить сюди лише всередині кластера.
- **`TRUST_PROXY`** у `backend/.env` — кількість проксі між клієнтом і бекендом (ingress = `1`; якщо перед ingress є ще CDN чи балансувальник — більше). Від нього залежать IP-ліміти; на беті `>= 1` обов'язково.
- **Access-логи** ingress для `/api/cal/` вимкніть або приховайте шлях: у ньому секретний токен ICS-фіду.
- **Redis** — лише в приватній мережі й **з паролем**: `REDIS_URL=redis://:пароль@host:6379` (або ACL-користувач). Доступ до Redis рівнозначний доступу до будь-якого акаунта. MySQL і Redis назовні не публікуються.
- [`Caddyfile.example`](Caddyfile.example) — приклад для окремого сервера з Docker; у кластері необов'язковий і не потрібний.

### Прев'ю посилань, sitemap, robots

Боти прев'ю (Telegram, Discord, Facebook, Twitter, Slack, LinkedIn, WhatsApp) не виконують JS: для сторінок ігор і профілів ingress має віддавати їм мінімальний HTML з OG-метаданими: `/games/<id>` → `/api/og/games/<id>`, `/users/<publicId>` → `/api/og/users/<publicId>`, сторінка спонсорів `/sponsors` → `/api/og/sponsors`. Googlebot отримує звичайний SPA. Готові правила для nginx (`map $http_user_agent`) — у [README, «SEO і прев'ю посилань»](../../README.md#seo-і-превю-посилань). `/sitemap.xml` і `/robots.txt` віддає бекенд (на беті — `Disallow: /`).

## Міграції

Окремий Job перед оновленням бекенду: образ `ttrpg-backend` **з тим самим дайджестом**, що й у бекенду, той самий `.env`, команда:

```
node --import tsx src/db/migrate.ts
```

(робоча тека — `backend/` в образі). Успіх — код `0` і рядок `migrations applied`. Повторний запуск безпечний (застосовані пропускаються). Порядок: Job завершився успішно, тоді розкатка backend, тоді bot. Якщо Job впав, backend не розкочується. Правила для нових міграцій — [migrations.md](migrations.md).

## Бекапи

Образ `ttrpg-backup` — довго працюючий сервіс (Deployment на 1 репліку), **не CronJob**: розклад усередині (бекап щодня 03:30 UTC, перевірка відновлення щонеділі 04:30 UTC). Налаштовується лише `.env`; докладно — [backups.md](backups.md).

- Змінні: `BACKUP_PASSPHRASE`, `BACKUP_DB_HOST` (сервіс MySQL; за замовчуванням `mysql`), `BACKUP_DB_PORT`, `BACKUP_DB_USER`/`BACKUP_DB_PASSWORD` (користувач `backup`, права — у backups.md), `BACKUP_S3_ENDPOINT`/`BUCKET`/`ACCESS_KEY_ID`/`SECRET_ACCESS_KEY`/`REGION` (Cloudflare R2). `BACKUP_ENABLED=false` — сервіс простоює (бета).
- **Том:** змонтуйте PVC у `/backups` (локальні копії: 30 щоденних + 12 місячних). Без запису в `/backups` сервіс завершується з поясненням у логу.
- **Довільний UID:** образ працює з будь-яким non-root UID (за замовчуванням числовий `USER 999`). Том має бути записуваним: задайте `securityContext.fsGroup` (і за потреби `runAsUser`). Образ пише лише в `/backups` і `/tmp`, тож `readOnlyRootFilesystem: true` можливий, якщо `/tmp` — `emptyDir` (бажано `medium: Memory`: там тимчасовий файл із паролем MySQL).
- `terminationGracePeriodSeconds` — до 600 с: бекап, що вже йде, дочікується.
- Разовий бекап: `kubectl exec … -- /opt/backup/backup-entrypoint.sh backup`.
