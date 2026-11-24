import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const optional = z.string().min(1).optional();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().min(1).default('http://localhost:4200'),
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_TEST: optional,
  REDIS_URL: z.string().min(1),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  IDENTITY_PEPPER: z.string().min(1),
  INTERNAL_API_KEY: z.string().min(1),
  TELEGRAM_BOT_TOKEN: optional,
  TELEGRAM_BOT_USERNAME: optional,
  TELEGRAM_LOGIN_MAX_AGE_SEC: z.coerce.number().int().positive().default(86400),
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  DEV_LOGIN_ENABLED: bool,
  DEV_OWNER_KEY: optional,
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(20),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  // Порожні значення з .env трактуємо як «не задано».
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
    throw new Error(`Invalid environment, check: ${keys.join(', ')}`);
  }
  return parsed.data;
}
