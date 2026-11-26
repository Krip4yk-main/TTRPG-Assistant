# Бекапи БД

Сервіс `backup` у `docker-compose.prod.yml` (образ з `scripts/ops/Dockerfile.backup`, скрипти в `scripts/ops/`).

## Що і коли

- **Щодня о 03:30 UTC** — дамп БД `nri` (`mysqldump --single-transaction --routines --triggers`) → `gzip` → `openssl enc -aes-256-cbc -pbkdf2` одним пайпом. Незашифрований дамп на диск не пишеться ніколи. Файл `nri-YYYY-MM-DDTHHMMZ.sql.gz.enc` у volume `backups`.
- Якщо контейнер стартував після 03:30, а сьогоднішнього бекапу ще немає, бекап робиться одразу. Якщо бекап не вдався, наступна спроба буде наступного дня (у лозі `ERROR`).
- **Локальна ротація:** 7 останніх щоденних у корені volume + 4 щотижневих (недільних) у `weekly/`.
- **Копія поза сервером:** Cloudflare R2 або Backblaze B2 (S3-API) через `rclone`, префікс `<bucket>/nri/`. Віддалено файли старші за 30 днів видаляються. Якщо `BACKUP_S3_*` не задано, бекап лишається тільки локально, а в лозі буде `WARN: off-site copy disabled`. Якщо задано лише частину змінних, це `ERROR` і ненульовий код (локальний бекап при цьому зберігається).
- **Щонеділі о 04:30 UTC** — перевірка відновлення (див. нижче).
- Без `BACKUP_PASSPHRASE` сервіс не робить нічого: помилка в лозі й ненульовий код (fail closed).

Логи: `docker compose -f docker-compose.prod.yml logs backup`.

## Користувач MySQL `backup`

Root не використовується. Створіть користувача один раз (пароль — значення `BACKUP_DB_PASSWORD`; без символів `"`, `\` і переносу рядка):

```sql
CREATE USER 'backup'@'%' IDENTIFIED BY '<пароль>';
-- дамп
GRANT SELECT, LOCK TABLES, SHOW VIEW, TRIGGER ON `nri`.* TO 'backup'@'%';
GRANT SHOW_ROUTINE ON *.* TO 'backup'@'%';   -- лише читання визначень процедур (--routines)
-- перевірка відновлення: тільки тимчасова БД (`\_` — буквальне підкреслення, а не шаблон)
GRANT ALL PRIVILEGES ON `nri\_restore\_check`.* TO 'backup'@'%';
```

Виконати можна так (пароль root береться з оточення контейнера `mysql` і в аргументи не потрапляє):

```sh
docker compose -f docker-compose.prod.yml exec mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot'
```

## Бакет поза сервером (безкоштовно)

**Cloudflare R2** (10 ГБ безкоштовно; Cloudflare може попросити прив'язати картку для активації R2):
1. Dashboard → R2 → Create bucket (наприклад, `nri-backups`).
2. R2 → Manage API tokens → Create API token: дозвіл **Object Read & Write**, лише для цього бакета.
3. Збережіть Access Key ID і Secret Access Key. Endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, регіон `auto`.

**Backblaze B2** (10 ГБ безкоштовно, без картки):
1. Buckets → Create a Bucket, тип **Private**. У Lifecycle Settings виберіть **Keep only the last version of the file**, бо інакше видалені файли лишаються прихованими версіями й займають місце.
2. Application Keys → Add a New Application Key: доступ лише до цього бакета, Read and Write.
3. `keyID` → access key, `applicationKey` → secret. Endpoint вказано на сторінці бакета: `https://s3.<регіон>.backblazeb2.com`, регіон — наприклад `eu-central-003`.

## Змінні (кореневий `.env`, див. `.env.template`)

`BACKUP_PASSPHRASE`, `BACKUP_DB_USER` (за замовчуванням `backup`), `BACKUP_DB_PASSWORD`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_REGION` (необов'язково).

Збережіть копію `BACKUP_PASSPHRASE` поза сервером (наприклад, у менеджері паролів), бо без неї бекапи не розшифрувати.

## Ручні команди

```sh
# бекап зараз
docker compose -f docker-compose.prod.yml run --rm backup backup
# перевірка відновлення зараз
docker compose -f docker-compose.prod.yml run --rm backup restore-check
# список локальних бекапів
docker compose -f docker-compose.prod.yml run --rm --entrypoint ls backup -l /backups /backups/weekly
```

## Перевірка відновлення

`restore-check` бере останній локальний бекап, розшифровує його й розгортає в тимчасову БД `nri_restore_check` на тому ж MySQL. Потім порівнює кількість рядків у `users`, `games`, `game_members`, `game_sessions`, `notifications` з живою БД (допуск ±1 %, але не менше ±5 рядків), друкує `OK`/`FAIL` по кожній таблиці й підсумок `restore-check OK|FAIL`. Тимчасова БД видаляється на виході за будь-якого результату. Якщо результат `FAIL`, код виходу ненульовий.

## Відновлення вручну

Зупиніть застосунок, щоб він не писав у БД під час відновлення:

```sh
docker compose -f docker-compose.prod.yml stop backend bot
```

З локального volume. Розшифрований потік іде пайпом прямо в `mysql` і на диск не потрапляє:

```sh
F=nri-2026-01-01T0330Z.sql.gz.enc   # потрібний файл (або weekly/<файл>)
docker compose -f docker-compose.prod.yml run --rm -T --entrypoint sh backup -c \
  "openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE -in /backups/$F | gzip -dc" \
  | docker compose -f docker-compose.prod.yml exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot nri'
docker compose -f docker-compose.prod.yml start backend bot
```

З копії в R2/B2 (на будь-якій машині з OpenSSL ≥ 1.1.1): завантажте файл з дашборда бакета, задайте `BACKUP_PASSPHRASE` в оточенні й виконайте:

```sh
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE -in nri-...sql.gz.enc | gzip -dc | mysql -h <хост> -u <користувач> -p nri
```

Дамп не містить `CREATE DATABASE`/`USE`, тому його можна розгорнути в будь-яку БД.
