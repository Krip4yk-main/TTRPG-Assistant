import { z } from 'zod';

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  BACKEND_INTERNAL_URL: z.url(),
  INTERNAL_API_KEY: z.string().min(32),
  // Адреса сайту для посилань у сповіщеннях.
  PUBLIC_BASE_URL: z.url().default('http://localhost:4200'),
});
export type BotEnv = z.infer<typeof schema>;

/** Кидає зрозумілу помилку з переліком змінних, яких бракує (значень не друкує). */
export function loadEnv(source: Record<string, string | undefined> = process.env): BotEnv {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new Error(
      `Некоректна конфігурація бота: перевірте ${names.join(', ')} у bot/.env (див. bot/.env.template)`,
    );
  }
  return parsed.data;
}
