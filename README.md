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

## Розгортання

### Збірка образів

Усі образи збираються з кореня репозиторію (базовий образ `node:26-alpine`, процеси працюють не від root; фронтенд — `nginxinc/nginx-unprivileged`):

```bash
docker build -f backend/Dockerfile -t nri-backend .
docker build -f bot/Dockerfile -t nri-bot .
docker build -f frontend/Dockerfile -t nri-frontend   --build-arg NG_APP_TELEGRAM_BOT_USERNAME=<bot_username>   --build-arg NG_APP_GOOGLE_LOGIN=true .
```

Фронтенд налаштовується на етапі збірки (build args `NG_APP_TELEGRAM_BOT_USERNAME`, `NG_APP_GOOGLE_LOGIN`, `NG_APP_DEV_LOGIN`, останній за замовчуванням `false`), образ — nginx зі статикою на порту 8080 (SPA: `try_files … /index.html`). Бекенд слухає порт 3000. Запускайте контейнери з `docker run --init` (або `init: true` у compose), щоб сигнали та зомбі-процеси оброблялися коректно.

### Змінні середовища

- backend: [`backend/.env.template`](backend/.env.template) (передавайте через `--env-file` або секрети оркестратора);
- bot: [`bot/.env.template`](bot/.env.template);
- frontend: [`frontend/.env.template`](frontend/.env.template) (лише build args, не секрети).

Обов'язково для production:

- `NODE_ENV=production` — задайте явно (за замовчуванням `development`);
- `DEV_LOGIN_ENABLED` не задавати або `false`;
- `TRUST_PROXY` — кількість проксі перед бекендом (наприклад, `1`);
- `PUBLIC_BASE_URL` — публічний https-URL застосунку; `IDENTITY_PEPPER`, `INTERNAL_API_KEY` — унікальні випадкові значення (≥32 символи, `openssl rand -base64 32`), `INTERNAL_API_KEY` однаковий у backend і bot.
- `IDENTITY_PEPPER` **ніколи не змінюйте** після запуску: ротація анулює всі надгробки ідентичностей, зокрема бани видалених акаунтів;
- Redis у production — лише в приватній мережі і **з автентифікацією** (`requirepass` або ACL-користувач, `REDIS_URL=redis://user:password@host:6379`): бекенд довіряє вмісту Redis (кеш сесій, надгробки відкликаних сесій, OAuth state), тож доступ до Redis рівнозначний доступу до будь-якого акаунта;
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

- Бібліотека OAuth `arctic` позначена як deprecated — замініть до production.
- Шрифти підвантажуються з Google CDN.

## Автор

- GitHub: <GITHUB_URL>
- Email: <EMAIL>
- Telegram: <TELEGRAM>
- LinkedIn: <LINKEDIN>
