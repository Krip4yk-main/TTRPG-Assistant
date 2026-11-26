# Розгортання (production)

Стек описано в `docker-compose.prod.yml`: `mysql`, `redis`, `migrate` (одноразово), `backend` (API + воркер джобів), `bot`, `frontend`, `backup` (зашифровані бекапи БД, див. [backups.md](backups.md)).
Порти `backend` (3000) і `frontend` (8080) відкриті лише на `127.0.0.1` — `/api`, `/socket.io` і статику публікує зовнішній reverse proxy. `mysql` і `redis` назовні не публікуються.

## Підготовка

1. Скопіюйте `backend/.env.template` у `backend/.env`, `bot/.env.template` у `bot/.env` й заповніть (`NODE_ENV=production`, `TRUST_PROXY` за кількістю проксі, `DEV_LOGIN_ENABLED=false`).
2. У кореневому `.env` задайте `MYSQL_ROOT_PASSWORD`, `MYSQL_USER`, `MYSQL_PASSWORD` (пароль без символів, що ламають URL: `@ : / ? #`).
3. `DATABASE_URL`, `REDIS_URL` і `BACKEND_INTERNAL_URL` у compose перевизначаються на адреси сервісів — у `.env` їх можна не задавати.
4. Налаштування фронтенду (`NG_APP_*`) — build-аргументи, див. `frontend/Dockerfile`.
5. Бекапи: створіть MySQL-користувача `backup` і задайте `BACKUP_*` у кореневому `.env` — див. [backups.md](backups.md). Без `BACKUP_PASSPHRASE` сервіс `backup` не працює (fail closed).

## Збірка і запуск

```sh
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

Порядок старту: `mysql` стає healthy → `migrate` виконує міграції й завершується → `backend` стартує лише після успішної міграції (і `redis` healthy) → `bot` чекає healthy `backend`. Окремо запускати міграції не потрібно.

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
curl -s http://127.0.0.1:3000/api/health        # повна перевірка: MySQL, Redis, воркер; 200 або 503
```
