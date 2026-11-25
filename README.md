# НРІ Асистент

Вебзастосунок для пошуку ігор у настільних рольових іграх (НРІ): майстри публікують набори, гравці знаходять ігри. Монорепозиторій із воркспейсами `shared`, `backend`, `frontend`, `bot`.

## Вимоги

- Node.js 26 (LTS)
- Docker (для локальних MySQL та Redis)

## Запуск

```bash
npm i
cp .env.template .env      # корінь: змінні для docker-compose
npm run dev:db             # MySQL 8.4 + Redis 8
```

Далі скопіюйте `.env.template` → `.env` у кожній частині (`backend`, `frontend`, `bot`), після чого:

```bash
npm run db:migrate -w backend
npm run dev -w backend
npm run dev -w frontend
npm run dev -w bot
```

Корисні команди: `npm run lint`, `npm run typecheck`, `npm test`.

Тести бекенду йдуть паралельно (4 воркери): кожен воркер створює й мігрує власну БД `nri_test_<N>`, тож тестовому користувачу MySQL потрібні права на `nri\_test\_%` (див. `docker/mysql-init.sql`). Якщо том MySQL створено раніше, виконайте один раз від root: ``GRANT ALL PRIVILEGES ON `nri\_test\_%`.* TO 'nri'@'%';``

Нотатки для розробки:

- Після змін у `@nri/shared` перезберіть його (`npm run build -w shared`) і перезапустіть `ng serve`, видаливши `frontend/.angular/cache` (Vite попередньо збирає лінкований пакет).
- Часовий пояс акаунта визначає календар доступності, а не навпаки: сітка календаря показується в поясі акаунта, `PUT /api/me/availability` пояс не змінює (поле `timezone` у тілі ігнорується). Змінити пояс можна лише в налаштуваннях акаунта (`PATCH /api/me/timezone`); слоти при цьому не перераховуються — вт 19:00–23:00 лишається вт 19:00–23:00 у новому поясі.

## Розгортання

### Збірка образів

Усі образи збираються з кореня репозиторію (базовий образ `node:26-alpine`, процеси працюють не від root; фронтенд — `nginxinc/nginx-unprivileged`):

```bash
docker build -f backend/Dockerfile -t nri-backend .
docker build -f bot/Dockerfile -t nri-bot .
docker build -f frontend/Dockerfile -t nri-frontend   --build-arg NG_APP_TELEGRAM_BOT_USERNAME=<bot_username>   --build-arg NG_APP_GOOGLE_LOGIN=true   --build-arg NG_APP_DISCORD_LOGIN=true .
```

Фронтенд налаштовується на етапі збірки (build args `NG_APP_TELEGRAM_BOT_USERNAME`, `NG_APP_GOOGLE_LOGIN`, `NG_APP_DISCORD_LOGIN`, `NG_APP_DEV_LOGIN`, останній за замовчуванням `false`), образ — nginx зі статикою на порту 8080 (SPA: `try_files … /index.html`). Бекенд слухає порт 3000. Запускайте контейнери з `docker run --init` (або `init: true` у compose), щоб сигнали та зомбі-процеси оброблялися коректно.

### Змінні середовища

- backend: [`backend/.env.template`](backend/.env.template) (передавайте через `--env-file` або секрети оркестратора);
- bot: [`bot/.env.template`](bot/.env.template);
- frontend: [`frontend/.env.template`](frontend/.env.template) (лише build args, не секрети).

Обов'язково для production:

- `NODE_ENV=production` — задайте явно (за замовчуванням `development`);
- `DEV_LOGIN_ENABLED` не задавати або `false`;
- `TRUST_PROXY` — кількість проксі перед бекендом (наприклад, `1`);
- `PUBLIC_BASE_URL` — публічний https-URL застосунку; `IDENTITY_PEPPER`, `INTERNAL_API_KEY` — унікальні випадкові значення (≥32 символи, `openssl rand -base64 32`), `INTERNAL_API_KEY` однаковий у backend і bot. Бот теж потребує `PUBLIC_BASE_URL` (посилання в Telegram-сповіщеннях): з `NODE_ENV=production` (так у `bot/Dockerfile`) без нього бот не стартує — локальна заглушка `http://localhost:4200` діє лише в dev/test.
- `IDENTITY_PEPPER` **ніколи не змінюйте** після запуску: ротація анулює всі надгробки ідентичностей, зокрема бани видалених акаунтів;
- Redis у production — лише в приватній мережі і **з автентифікацією** (`requirepass` або ACL-користувач, `REDIS_URL=redis://user:password@host:6379`): бекенд довіряє вмісту Redis (кеш сесій, надгробки відкликаних сесій, OAuth state), тож доступ до Redis рівнозначний доступу до будь-якого акаунта;
- вхід через Google / Discord — необов'язковий: задайте `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` чи `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` (redirect URI — `${PUBLIC_BASE_URL}/api/auth/<google|discord>/callback`) і збирайте фронтенд з відповідним `NG_APP_GOOGLE_LOGIN=true` / `NG_APP_DISCORD_LOGIN=true`; без змінних ендпоінти провайдера відповідають NOT_FOUND;
- MySQL і Redis не публікуйте назовні: локальний `docker-compose.yml` прив'язує їхні порти лише до `127.0.0.1`.

### Reverse proxy

Фронтенд і API мають бути на **одному origin** за reverse proxy:

- `/api` і `/socket.io` (із заголовками WebSocket upgrade: `Upgrade`, `Connection`) → backend:3000;
- усе інше → frontend:8080;
- `/api/internal/*` має **блокуватися** для публічного інтернету (повертати 404/403): бот звертається до бекенду напряму по внутрішній мережі.

Приклад для nginx:

```nginx
location /api/internal/ { return 404; }   # має стояти перед /api/

location /api/ {
  proxy_pass http://backend:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location /socket.io/ {
  proxy_pass http://backend:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location / {
  proxy_pass http://frontend:8080;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

#### SEO і прев'ю посилань

`/sitemap.xml` і `/robots.txt` віддає бекенд (без сесії; кеш 1 год) — проксіюйте їх на backend. Боти прев'ю посилань (Telegram, Discord, Facebook, Twitter, Slack, LinkedIn, WhatsApp) не виконують JS, тож для сторінок ігор і профілів їх варто перенаправляти на мінімальні HTML-документи з OG-метаданими (`/api/og/games/:id`, `/api/og/users/:publicId`). Googlebot рендерить JS і має отримувати SPA, тому в список ботів його не додавайте. Блоки нижче розмістіть **перед** `location /`; `map` — у контексті `http`:

```nginx
map $http_user_agent $is_preview_bot {
  default 0;
  ~*(TelegramBot|Discordbot|facebookexternalhit|Twitterbot|Slackbot|LinkedInBot|WhatsApp) 1;
}

location = /sitemap.xml {
  proxy_pass http://backend:3000;
  proxy_set_header Host $host;
}

location = /robots.txt {
  proxy_pass http://backend:3000;
  proxy_set_header Host $host;
}

location ~ ^/games/(\d+)$ {
  if ($is_preview_bot) { rewrite ^/games/(\d+)$ /api/og/games/$1 last; }
  proxy_pass http://frontend:8080;
  proxy_set_header Host $host;
}

location ~ ^/users/([a-z0-9]+)$ {
  if ($is_preview_bot) { rewrite ^/users/([a-z0-9]+)$ /api/og/users/$1 last; }
  proxy_pass http://frontend:8080;
  proxy_set_header Host $host;
}
```

Ігри з віковою позначкою 16+/18+/21+, чернетки та скасовані ігри, а також видалені профілі отримують нейтральні мета-теги з `noindex` і без опису.

`TRUST_PROXY` має дорівнювати кількості проксі-хопів перед бекендом: хибне значення ламає IP у rate-limit і secure-cookie.

### Міграції

Бекенд не виконує міграції при старті. Запускайте перед першим стартом і після кожного оновлення:

```bash
docker run --rm --env-file backend/.env nri-backend node --import tsx src/db/migrate.ts
# або з вихідного коду: npm run db:migrate -w backend
```

### Вхід через Telegram і Google

- Telegram Login: у BotFather виконайте `/setdomain` і вкажіть домен застосунку.
- Google OAuth: redirect URI — `${PUBLIC_BASE_URL}/api/auth/google/callback`.

### Власник

Власник спершу входить в застосунок і заповнює профіль, після чого на сервері:

```bash
npm run seed:owner -w backend -- --nickname <nick>
# або в контейнері:
docker run --rm --env-file backend/.env nri-backend node --import tsx src/cli/seed-owner.ts --nickname <nick>
```

### Відомі обмеження

- Шрифти підвантажуються з Google CDN.

## Автор

- GitHub: [Krip4yk-main](https://github.com/Krip4yk-main)
- Email: [krip4yk.main@gmail.com](mailto:krip4yk.main@gmail.com)
- Telegram: [@krip4yk](https://t.me/krip4yk)
- LinkedIn: [Viacheslav Mykhalchenko](https://www.linkedin.com/in/viacheslav-mykhalchenko-752042171/)
