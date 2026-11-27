# Середовища: local, dev, prod

Змінна `DEPLOY_ENV` (`local` | `dev` | `prod`, за замовчуванням `local`) визначає, де працює застосунок.
Бекенд перевіряє її в `backend/src/config/env.ts`: для `dev` і `prod` обов'язкові `NODE_ENV=production`
та `https://` у `PUBLIC_BASE_URL`, інакше бекенд не стартує (як і для звичайного production).

|                                                              | local                                      | dev                                                                       | prod                          |
| ------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------- |
| Де                                                           | машина розробника                          | окремий сервер                                                            | основний сервер               |
| `DEPLOY_ENV`                                                 | `local` (дефолт, нічого задавати не треба) | `dev`                                                                     | `prod`                        |
| Домен                                                        | `localhost:4200`                           | свій dev-домен (https)                                                    | основний домен (https)        |
| БД / Redis                                                   | з кореневого `docker-compose.yml`          | свої, у стеку цього сервера                                               | свої, у стеку цього сервера   |
| Telegram-бот                                                 | за бажанням, свій                          | **окремий тестовий бот** (свій токен)                                     | бойовий бот                   |
| OAuth Google/Discord                                         | за бажанням                                | **окремі застосунки** з redirect URI dev-домену                           | окремі застосунки prod-домену |
| `CALENDAR_IMPORT_KEY`, `INTERNAL_API_KEY`, `IDENTITY_PEPPER` | довільні                                   | **свої**, не з prod                                                       | свої                          |
| Бекапи                                                       | немає                                      | вимкнено (`BACKUP_ENABLED=false`)                                         | щодня, ротація 30 + 12 міс.   |
| Індексація                                                   | —                                          | заборонена: `X-Robots-Tag: noindex, nofollow`, `robots.txt` `Disallow: /` | дозволена                     |
| Банер у UI                                                   | немає                                      | «Тестове середовище»                                                      | немає                         |

## Як це працює

- Бекенд на `dev` додає `X-Robots-Tag: noindex, nofollow` до всіх відповідей і віддає `/robots.txt` з `Disallow: /`.
- Фронтенд-контейнер (nginx) на `dev` теж додає `X-Robots-Tag` (за змінною `DEPLOY_ENV` контейнера).
- Банер «Тестове середовище» показується, якщо фронтенд зібрано з `NG_APP_DEPLOY_ENV=dev`
  (compose передає build-аргумент із `DEPLOY_ENV`). Зміна середовища вимагає перезбірки фронтенду.
- Сервіс `backup` при `BACKUP_ENABLED=false` пише один рядок у лог і простоює (без помилок і без перезапусків).
- Dev і prod використовують **той самий** `docker-compose.prod.yml` з різними env-файлами.

## Запуск dev-сервера крок за кроком

1. Окремий сервер (не той, де prod) із Docker і reverse proxy на `127.0.0.1:3000` (`/api`, `/socket.io`) та `127.0.0.1:8080` (статика) — як у [deploy.md](deploy.md), з власним dev-доменом і https-сертифікатом.
2. **Telegram:** у @BotFather створіть окремого тестового бота (`/newbot`) — його токен і username лише для dev. Для Login Widget задайте домен: `/setdomain` → dev-домен.
3. **Google:** окремий OAuth client (Web); redirect URI `https://<dev-домен>/api/auth/google/callback`.
4. **Discord:** окремий Application; Redirects `https://<dev-домен>/api/auth/discord/callback`.
5. `cp .env.dev.template .env.dev` і заповніть (власні паролі MySQL; `BACKUP_ENABLED=false`; `NG_APP_TELEGRAM_BOT_USERNAME` — тестовий бот).
6. `cp backend/.env.template backend/.env`: `NODE_ENV=production`, `PUBLIC_BASE_URL=https://<dev-домен>`, `TRUST_PROXY` за кількістю проксі, `DEV_LOGIN_ENABLED=false`, **нові** `IDENTITY_PEPPER`, `INTERNAL_API_KEY`, `CALENDAR_IMPORT_KEY` (`openssl rand -base64 32`), токен і username тестового бота, ключі Google/Discord з кроків 3–4.
7. `cp bot/.env.template bot/.env`: токен тестового бота, `INTERNAL_API_KEY` дослівно як у `backend/.env`, `PUBLIC_BASE_URL=https://<dev-домен>`.
8. Запуск:

   ```sh
   docker compose --env-file .env.dev -f docker-compose.prod.yml build
   docker compose --env-file .env.dev -f docker-compose.prod.yml up -d
   ```

9. Перевірка: `curl -sI https://<dev-домен>/robots.txt` (є `X-Robots-Tag: noindex, nofollow`, тіло `Disallow: /`); у браузері — банер «Тестове середовище».

`--env-file` вказуйте при **кожній** команді compose (`logs`, `down`, `ps` теж), інакше змінні не підставляться.

## Як не переплутати токени

- Токени тестового бота й OAuth-ключі dev живуть лише на dev-сервері (`backend/.env`, `bot/.env`); у prod-файли їх не копіюйте і навпаки.
- Різні `IDENTITY_PEPPER`, `INTERNAL_API_KEY`, `CALENDAR_IMPORT_KEY` на dev і prod; дані не переносьте між БД (dev-БД не містить реальних користувачів).
- Тестового бота легко відрізнити за іменем (наприклад, `..._dev_bot`), а сайт — за банером «Тестове середовище».
- Перед запуском `up -d` перевірте, що поточний каталог і env-файл відповідають серверу: `grep ^DEPLOY_ENV .env.dev` має дати `dev`.
- Файли `.env.dev` / `.env.prod` в `.gitignore`; у git лише шаблони `.env.dev.template` і `.env.prod.template`.
