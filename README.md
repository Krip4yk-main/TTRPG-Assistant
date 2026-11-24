# НРІ Асистент

Вебзастосунок для пошуку ігор у настільних рольових іграх (НРІ): майстри публікують набори, гравці знаходять ігри. Монорепозиторій із воркспейсами `shared`, `backend`, `frontend`, `bot`.

## Вимоги

- Node.js 24
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

## Автор

- GitHub: <GITHUB_URL>
- Email: <EMAIL>
- Telegram: <TELEGRAM>
- LinkedIn: <LINKEDIN>
