import { z } from 'zod';

/**
 * Публічні налаштування, які фронтенд бере з бекенду під час запуску (`GET /api/public-config`):
 * лише те, що й так видно на сторінці входу. Нічого про dev-вхід, версії чи адреси.
 */
export const publicConfigSchema = z.object({
  /** Ім'я Telegram-бота без `@` для Login Widget; `null` — вхід через Telegram вимкнено. */
  telegramBotUsername: z.string().min(1).nullable(),
  providers: z.object({
    telegram: z.boolean(),
    google: z.boolean(),
    discord: z.boolean(),
  }),
});
export type PublicConfigDto = z.infer<typeof publicConfigSchema>;
