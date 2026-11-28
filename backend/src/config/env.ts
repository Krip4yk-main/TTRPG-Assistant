import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const optional = z.string().min(1).optional();

/**
 * Ключ шифрування посилань імпорту iCal (AES-256-GCM): base64 рівно 32 байтів
 * (`openssl rand -base64 32`). Не задано — імпорт вимкнено (API відповідає
 * `CALENDAR_IMPORT_DISABLED`), посилання у відкритому вигляді не зберігаються ніколи.
 */
const calendarImportKey = z
  .string()
  .refine((v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length === 32)
  .optional();

/** Повідомлення, які варто показати поруч із ключем (а не лише назву ключа). */
const HTTPS_IN_PROD = 'must be an https:// URL in production';
const PROD_IN_DEPLOY = 'must be production when DEPLOY_ENV is dev or prod';
const NOT_ON_PROD = 'must not be set when DEPLOY_ENV=prod';
const CODES_REQUIRED_ON_DEV = 'required when DEV_LOGIN_ENABLED=true on DEPLOY_ENV=dev';
const CODE_TOO_SHORT = 'each code must be at least 24 characters (at most 256)';
const CODE_LOW_ENTROPY = 'each code must have at least 8 distinct characters (use random codes)';
const CODES_MALFORMED = 'comma-separated codes or label:code, labels [A-Za-z0-9_.-], no duplicates';
/** Показуються поруч із ключем; значень у тексті помилки немає ніколи (там можуть бути секрети). */
const EXPLAINED = new Set([
  HTTPS_IN_PROD,
  PROD_IN_DEPLOY,
  NOT_ON_PROD,
  CODES_REQUIRED_ON_DEV,
  CODE_TOO_SHORT,
  CODE_LOW_ENTROPY,
  CODES_MALFORMED,
]);

export const DEV_LOGIN_CODE_MIN = 24;
/** Проти очевидно слабких кодів (`aaaa…`, `abcabc…`): мінімум різних символів. */
const DEV_LOGIN_CODE_MIN_DISTINCT = 8;
const DEV_LOGIN_CODE_MAX = 256;
const DEV_LOGIN_LABEL = /^[A-Za-z0-9_.-]{1,32}$/;

/** Код dev-входу на бета-сервері: мітка (для журналу) і сам код (секрет). */
export interface DevLoginCode {
  label: string;
  code: string;
}

/**
 * `DEV_LOGIN_CODES`: коди через кому, кожен — `код` або `мітка:код` (до першої `:`). Без мітки
 * мітка — `#позиція` (з 1). Код ≥ 24 символів, з них ≥ 8 різних; порожні записи й дублікати — помилка старту.
 */
const devLoginCodes = z
  .string()
  .optional()
  .transform((raw, ctx): DevLoginCode[] => {
    if (raw === undefined) return [];
    const out: DevLoginCode[] = [];
    const fail = (message: string) => {
      ctx.addIssue({ code: 'custom', message });
      return z.NEVER;
    };
    for (const [i, entry] of raw.split(',').entries()) {
      const item = entry.trim();
      const colon = item.indexOf(':');
      const label = colon === -1 ? `#${i + 1}` : item.slice(0, colon).trim();
      const code = colon === -1 ? item : item.slice(colon + 1).trim();
      if (!item || (colon !== -1 && !DEV_LOGIN_LABEL.test(label)) || /\s/.test(code)) {
        return fail(CODES_MALFORMED);
      }
      if (code.length < DEV_LOGIN_CODE_MIN || code.length > DEV_LOGIN_CODE_MAX) {
        return fail(CODE_TOO_SHORT);
      }
      if (new Set(code).size < DEV_LOGIN_CODE_MIN_DISTINCT) return fail(CODE_LOW_ENTROPY);
      out.push({ label, code });
    }
    const unique = (xs: string[]) => new Set(xs).size === xs.length;
    if (!unique(out.map((c) => c.code)) || !unique(out.map((c) => c.label))) {
      return fail(CODES_MALFORMED);
    }
    return out;
  });

export const DEPLOY_ENVS = ['local', 'dev', 'prod'] as const;
export type DeployEnv = (typeof DEPLOY_ENVS)[number];

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /**
     * Середовище розгортання: `local` (машина розробника), `dev` (окремий тестовий сервер),
     * `prod`. `dev` і `prod` вимагають тих самих налаштувань, що й NODE_ENV=production.
     */
    DEPLOY_ENV: z.enum(DEPLOY_ENVS).default('local'),
    PORT: z.coerce.number().int().positive().default(3000),
    PUBLIC_BASE_URL: z.string().min(1).default('http://localhost:4200'),
    DATABASE_URL: z.string().min(1),
    DATABASE_URL_TEST: optional,
    REDIS_URL: z.string().min(1),
    /** Префікс каналів Redis-адаптера Socket.IO (усі екземпляри одного розгортання — однаковий). */
    REALTIME_ADAPTER_KEY: z.string().min(1).default('socket.io'),
    SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
    IDENTITY_PEPPER: z.string().min(32),
    INTERNAL_API_KEY: z.string().min(32),
    TELEGRAM_BOT_TOKEN: optional,
    TELEGRAM_BOT_USERNAME: optional,
    TELEGRAM_LOGIN_MAX_AGE_SEC: z.coerce.number().int().positive().default(86400),
    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,
    DISCORD_CLIENT_ID: optional,
    DISCORD_CLIENT_SECRET: optional,
    /**
     * Dev-вхід (за нікнеймом, без OAuth). `local`: лише з localhost, власник — за `DEV_OWNER_KEY`.
     * `dev` (бета): лише з кодом із `DEV_LOGIN_CODES`, без персоналу, `DEV_OWNER_KEY` не діє.
     * `prod`: заборонено — будь-яке з трьох значень зупиняє старт.
     */
    DEV_LOGIN_ENABLED: bool,
    DEV_LOGIN_CODES: devLoginCodes,
    DEV_OWNER_KEY: optional,
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(20),
    CALENDAR_IMPORT_KEY: calendarImportKey,
    /** Попередній ключ (ротація): лише для розшифрування; на наступній синхронізації — перешифрування. */
    CALENDAR_IMPORT_KEY_PREVIOUS: calendarImportKey,
  })
  // Розгортання dev/prod працює як production (secure-cookie, https-посилання).
  .refine((e) => e.DEPLOY_ENV === 'local' || e.NODE_ENV === 'production', {
    path: ['NODE_ENV'],
    message: PROD_IN_DEPLOY,
  })
  // Реліз: dev-входу немає взагалі — налаштування для нього означають помилку конфігурації.
  .superRefine((e, ctx) => {
    if (e.DEPLOY_ENV === 'prod') {
      const set = {
        DEV_LOGIN_ENABLED: e.DEV_LOGIN_ENABLED,
        DEV_LOGIN_CODES: e.DEV_LOGIN_CODES.length > 0,
        DEV_OWNER_KEY: e.DEV_OWNER_KEY !== undefined,
      };
      for (const [key, isSet] of Object.entries(set)) {
        if (isSet) ctx.addIssue({ code: 'custom', path: [key], message: NOT_ON_PROD });
      }
    }
    if (e.DEPLOY_ENV === 'dev' && e.DEV_LOGIN_ENABLED && e.DEV_LOGIN_CODES.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['DEV_LOGIN_CODES'], message: CODES_REQUIRED_ON_DEV });
    }
  })
  // У production посилання в листах, Telegram та ICS ведуть на PUBLIC_BASE_URL — лише https.
  .refine(
    (e) =>
      (e.NODE_ENV !== 'production' && e.DEPLOY_ENV === 'local') ||
      /^https:\/\/[^/]/i.test(e.PUBLIC_BASE_URL),
    { path: ['PUBLIC_BASE_URL'], message: HTTPS_IN_PROD },
  );

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // Порожні значення з .env трактуємо як «не задано».
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const keys = [
      ...new Set(
        parsed.error.issues.map((i) => {
          const key = i.path.join('.');
          return EXPLAINED.has(i.message) ? `${key} (${i.message})` : key;
        }),
      ),
    ];
    throw new Error(`Invalid environment, check: ${keys.join(', ')}`);
  }
  return parsed.data;
}
