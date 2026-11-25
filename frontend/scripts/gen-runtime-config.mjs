// Генерує src/environments/runtime-config.ts з frontend/.env та змінних середовища.
// Механізм свідомо простий: Angular CLI не читає .env, тому перед start/build/test
// (npm pre-скрипти) цей скрипт записує типізований TS-модуль, який імпортує застосунок.
// Згенерований файл у .gitignore; пріоритет: process.env > frontend/.env > порожньо.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

/**
 * Версія бандлів стилів дизайнів (`theme-<id>.css?v=…`): хеш вихідних стилів дизайнів
 * (`src/styles/**` і файли верхнього рівня `src/app/theming/themes/<id>/`) та версій пакетів,
 * що потрапляють у бандл (Material, шрифти). Бандли з `inject: false` Angular не хешує в імені,
 * тож після релізу браузер бере новий файл лише завдяки зміні `?v=`.
 */
function themeStyleVersion() {
  const hash = createHash('sha256');
  const addDir = (dir, recursive) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) {
        if (recursive) addDir(file, true);
      } else if (/\.(less|scss|css)$/.test(entry.name)) {
        hash.update(entry.name).update(readFileSync(file));
      }
    }
  };
  addDir(new URL('src/styles/', root), true);
  const themes = new URL('src/app/theming/themes/', root);
  if (existsSync(themes)) {
    for (const entry of readdirSync(themes, { withFileTypes: true })) {
      if (entry.isDirectory()) addDir(new URL(`${entry.name}/`, themes), false);
    }
  }
  const require = createRequire(new URL('package.json', root));
  for (const pkg of [
    '@angular/material',
    '@fontsource/cormorant-garamond',
    '@fontsource/kurale',
    '@fontsource/literata',
    '@fontsource/lora',
    '@material-symbols/font-400',
  ]) {
    try {
      hash.update(`${pkg}@${require(`${pkg}/package.json`).version}`);
    } catch {
      hash.update(`${pkg}@?`);
    }
  }
  return hash.digest('hex').slice(0, 12);
}

const config = {
  telegramBotUsername: get('NG_APP_TELEGRAM_BOT_USERNAME').replace(/^@/, ''),
  googleLogin: get('NG_APP_GOOGLE_LOGIN') === 'true',
  discordLogin: get('NG_APP_DISCORD_LOGIN') === 'true',
  devLogin: get('NG_APP_DEV_LOGIN') === 'true',
  themeStyleVersion: themeStyleVersion(),
};

const source = `// Згенеровано scripts/gen-runtime-config.mjs — не редагуйте вручну (файл у .gitignore).
export interface RuntimeConfig {
  /** Ім'я Telegram-бота для Login Widget; порожньо — віджет вимкнено. */
  readonly telegramBotUsername: string;
  /** Показувати вхід / прив'язку через Google. */
  readonly googleLogin: boolean;
  /** Показувати вхід / прив'язку через Discord. */
  readonly discordLogin: boolean;
  /** Показувати форму dev-входу. */
  readonly devLogin: boolean;
  /** Версія бандлів стилів дизайнів для \`?v=\` (хеш вихідних стилів і пакетів шрифтів). */
  readonly themeStyleVersion: string;
}

export const runtimeConfig: RuntimeConfig = ${JSON.stringify(config, null, 2)};
`;

const prev = existsSync(out) ? readFileSync(out, 'utf8') : '';
if (prev !== source) writeFileSync(out, source);
console.log(`runtime-config: ${fileURLToPath(out)}`);
