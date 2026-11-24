// Генерує src/environments/runtime-config.ts з frontend/.env та змінних середовища.
// Механізм свідомо простий: Angular CLI не читає .env, тому перед start/build/test
// (npm pre-скрипти) цей скрипт записує типізований TS-модуль, який імпортує застосунок.
// Згенерований файл у .gitignore; пріоритет: process.env > frontend/.env > порожньо.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const envFile = new URL('.env', root);
const out = new URL('src/environments/runtime-config.ts', root);

/** Мінімальний парсер KEY=VALUE (коментарі #, необов'язкові лапки). */
function parseEnv(text) {
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    vars[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}

const fileVars = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
const get = (key) => process.env[key] ?? fileVars[key] ?? '';

const config = {
  telegramBotUsername: get('NG_APP_TELEGRAM_BOT_USERNAME').replace(/^@/, ''),
  devLogin: get('NG_APP_DEV_LOGIN') === 'true',
};

const source = `// Згенеровано scripts/gen-runtime-config.mjs — не редагуйте вручну (файл у .gitignore).
export interface RuntimeConfig {
  /** Ім'я Telegram-бота для Login Widget; порожньо — віджет вимкнено. */
  readonly telegramBotUsername: string;
  /** Показувати форму dev-входу. */
  readonly devLogin: boolean;
}

export const runtimeConfig: RuntimeConfig = ${JSON.stringify(config, null, 2)};
`;

const prev = existsSync(out) ? readFileSync(out, 'utf8') : '';
if (prev !== source) writeFileSync(out, source);
console.log(`runtime-config: ${fileURLToPath(out)}`);
