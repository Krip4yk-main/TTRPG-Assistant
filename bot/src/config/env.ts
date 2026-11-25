import { z } from 'zod';

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  BACKEND_INTERNAL_URL: z.url(),
  INTERNAL_API_KEY: z.string().min(32),
  NODE_ENV: z.string().default('development'),
  // Адреса сайту для посилань у сповіщеннях; у production — обов'язкова (без localhost-заглушки).
  PUBLIC_BASE_URL: z.url().optional(),
});
export type BotEnv = Omit<z.infer<typeof schema>, 'PUBLIC_BASE_URL'> & { PUBLIC_BASE_URL: string };

const DEV_BASE_URL = 'http://localhost:4200';

/** Кидає зрозумілу помилку з переліком змінних, яких бракує (значень не друкує). */
export function loadEnv(source: Record<string, string | undefined> = process.env): BotEnv {
  const parsed = schema.safeParse(source);
  const names = parsed.success
    ? []
    : [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
  if (parsed.success && parsed.data.NODE_ENV === 'production' && !parsed.data.PUBLIC_BASE_URL) {
    names.push('PUBLIC_BASE_URL');
  }
  if (!parsed.success || names.length > 0) {
    throw new Error(
      `Некоректна конфігурація бота: перевірте ${names.join(', ')} у bot/.env (див. bot/.env.template)`,
    );
  }
  return { ...parsed.data, PUBLIC_BASE_URL: parsed.data.PUBLIC_BASE_URL ?? DEV_BASE_URL };
}
