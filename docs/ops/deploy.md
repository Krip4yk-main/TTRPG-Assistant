# Розгортання (production)

Той самий стек запускається і на окремому dev-сервері з іншим env-файлом — див. [environments.md](environments.md) (`DEPLOY_ENV`, `.env.dev.template`, `.env.prod.template`).

Стек описано в `docker-compose.prod.yml`: `mysql`, `redis`, `migrate` (одноразово), `backend` (API + воркер джобів), `bot`, `frontend`, `backup` (зашифровані бекапи БД, див. [backups.md](backups.md)).
Порти `backend` (3000) і `frontend` (8080) відкриті лише на `127.0.0.1` — `/api`, `/socket.io` і статику публікує зовнішній reverse proxy. `mysql` і `redis` назовні не публікуються.

## Підготовка

1. Скопіюйте `backend/.env.template` у `backend/.env`, `bot/.env.template` у `bot/.env` й заповніть (`NODE_ENV=production`, `PUBLIC_BASE_URL` лише `https://…` — інакше бекенд не стартує, `TRUST_PROXY` за кількістю проксі, `DEV_LOGIN_ENABLED=false`).
2. У кореневому `.env` задайте `MYSQL_ROOT_PASSWORD`, `MYSQL_USER`, `MYSQL_PASSWORD` (пароль без символів, що ламають URL: `@ : / ? #`).
3. `DATABASE_URL`, `REDIS_URL` і `BACKEND_INTERNAL_URL` у compose перевизначаються на адреси сервісів — у `.env` їх можна не задавати.
4. Налаштування фронтенду (`NG_APP_*`) — build-аргументи, див. `frontend/Dockerfile`.
5. Бекапи: створіть MySQL-користувача `backup` і задайте `BACKUP_*` у кореневому `.env` — див. [backups.md](backups.md). Без `MYSQL_*` compose відмовляється запускати стек. Без `BACKUP_PASSPHRASE` чи `BACKUP_DB_PASSWORD` застосунок стартує, а сервіс `backup` пише помилку в лог і не робить бекапів (fail closed): без парольної фрази він завершується й перезапускається, доки її не задано; без пароля БД щоденний бекап падає й повторюється наступної доби.
6. Reverse proxy: вимкніть або редагуйте access-логи для `/api/cal/` — у шляху ICS-фіду секретний токен.
7. HTTPS: найпростіше — Caddy на хості, сам отримує й продовжує сертифікати Let's Encrypt; готовий приклад з усіма правилами проксі — [Caddyfile.example](Caddyfile.example) (необов'язковий; для nginx — приклад у README, розділ «Reverse proxy»).

## Перший власник платформи

Власника не створюють вручну в БД: його призначає вхід через Telegram.

1. Дізнайтеся свій числовий Telegram id (це не `@username`): напишіть боту `@userinfobot` (або аналогу; перевірте, що він досі працює) — він відповість числом.
2. У `backend/.env` (і на dev, і на prod) задайте `OWNER_TELEGRAM_ID=<id>` і перезапустіть `backend`.
3. На сайті увійдіть через Telegram-віджет на сторінці входу з цим id — акаунт стане власником. Якщо Telegram уже прив'язано в акаунті (через бота), вийдіть і увійдіть заново через Telegram-віджет: прив'язка через бота власника не призначає. Це відбувається лише якщо активного власника ще немає, і лише один раз; подія пишеться в журнал адмінки (`owner.bootstrap`, діяч — «Система»).

Важливо:

- Якщо власник уже є (інша людина) — нічого не змінюється, у лозі бекенду одне попередження; передавайте власність через «Передача власності» в адмінці. Забанений чи видалений акаунт власником не стає.
- Бот Telegram права не видає: тільки перевірений вхід чи прив'язка через віджет на сайті.
- Персонал (модератори, адміни, власник) має мати прив'язаний Telegram: призначення ролі й передача власності без нього відхиляються (`409 TELEGRAM_REQUIRED`), а персонал не може відв'язати Telegram. Роль можна зняти й без Telegram.
- Наявному персоналу без Telegram при оновленні приходить одне сповіщення на сайті «прив'яжіть Telegram» (раз назавжди; міграція `0052`), а в адмінці стоїть позначка «Без Telegram». Ролі автоматично не знімаються.

## Збірка і запуск

```sh
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

Порядок старту: `mysql` стає healthy → `migrate` виконує міграції й завершується → `backend` стартує лише після успішної міграції (і `redis` healthy) → `bot` чекає healthy `backend`. Окремо запускати міграції не потрібно.

## Розгортання Плану 15

- Безпосередньо перед оновленням зробіть бекап БД (`docker compose -f docker-compose.prod.yml run --rm backup backup`): міграції `0045`–`0048` змінюють схему, а DDL у MySQL не транзакційний — частково застосовану міграцію не відкотити, лише відновити з бекапу.
- `DEPLOY_ENV` у compose за замовчуванням `prod`; для dev-сервера задайте `DEPLOY_ENV=dev` у його env-файлі (див. [environments.md](environments.md)).
- Перезберіть фронтенд (`build`): `DEPLOY_ENV` потрапляє в нього як build-аргумент (банер dev, кнопка «Повідомити»).

## Якщо `migrate` впав

`backend` не стартує. Дивіться причину:

```sh
docker compose -f docker-compose.prod.yml logs migrate
```

Виправте причину (доступ до БД, помилка в міграції) і повторіть `docker compose -f docker-compose.prod.yml up -d`.

## Перевірка

```sh
docker compose -f docker-compose.prod.yml ps
curl -s http://127.0.0.1:3000/api/health/live   # завжди 200, якщо процес живий
curl -s http://127.0.0.1:3000/api/health        # повна перевірка: MySQL, Redis, воркер (цикл задач просувався ≤ 5 хв тому); 200 або 503
```
