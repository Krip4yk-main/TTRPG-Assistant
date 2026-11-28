import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PublicConfigDto } from '@nri/shared';
import type { Env } from '../config/env.js';

type ConfigEnv = Pick<
  Env,
  | 'TELEGRAM_BOT_USERNAME'
  | 'TELEGRAM_BOT_TOKEN'
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_SECRET'
  | 'DISCORD_CLIENT_ID'
  | 'DISCORD_CLIENT_SECRET'
>;

/**
 * Публічні налаштування для фронтенду, виведені з `.env` бекенду. Лише те, що й так видно на
 * сторінці входу: ім'я бота й які способи входу ввімкнено. Жодних секретів, прапорців dev-входу,
 * версій чи адрес.
 */
export function buildPublicConfig(env: ConfigEnv): PublicConfigDto {
  const username = env.TELEGRAM_BOT_USERNAME?.replace(/^@/, '') ?? '';
  const telegram = username !== '' && !!env.TELEGRAM_BOT_TOKEN;
  return {
    telegramBotUsername: telegram ? username : null,
    providers: {
      telegram,
      google: !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET,
      discord: !!env.DISCORD_CLIENT_ID && !!env.DISCORD_CLIENT_SECRET,
    },
  };
}

/**
 * `GET /api/public-config` — без сесії й без CSRF-cookie (відповідь кешована публічно, тож
 * `Set-Cookie` у ній неприпустимий); кеш на хвилину. Змонтований до CSRF і сесії, під загальним
 * лімітом запитів.
 */
export function publicConfigRouter(env: ConfigEnv, limiter: RequestHandler): Router {
  const router = Router();
  router.get('/api/public-config', limiter, (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json(buildPublicConfig(env));
  });
  return router;
}
