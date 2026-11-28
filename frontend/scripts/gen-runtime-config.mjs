// Генерує src/environments/runtime-config.ts з frontend/.env та змінних середовища.
// Механізм свідомо простий: Angular CLI не читає .env, тому перед start/build/test
// (npm pre-скрипти) цей скрипт записує типізований TS-модуль, який імпортує застосунок.
// Згенерований файл у .gitignore; пріоритет: process.env > frontend/.env > порожньо.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
 * Версія бандлів стилів дизайнів (`theme-<id>.css?v=…`): хеш усіх вихідних стилів, з яких
 * збираються бандли (`src/styles/**` і `src/app/theming/themes/**` — разом зі спільними
 * `font-face.less`, `scene/**` і вкладеними файлами ефектів), та версій пакетів, що потрапляють
 * у бандл (`@angular/material` і всі `@fontsource/*` / `@material-symbols/*` з `package.json`).
 * Бандли з `inject: false` Angular не хешує в імені, тож після релізу браузер бере новий файл
 * лише завдяки зміні `?v=`. Детерміновано між ОС: відносні шляхи з `/`, сортування за кодами
 * символів, кінці рядків нормалізовано до `\n`.
 */
function themeStyleVersion() {
  const hash = createHash('sha256');
  const files = [];
  const walk = (dir, rel) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${rel}${entry.name}`;
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir), `${path}/`);
      else if (/\.(less|scss|css)$/.test(entry.name)) files.push(path);
    }
  };
  walk(new URL('src/styles/', root), 'src/styles/');
  walk(new URL('src/app/theming/themes/', root), 'src/app/theming/themes/');
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const path of files) {
    const text = readFileSync(new URL(path, root), 'utf8').replace(/\r\n?/g, '\n');
    hash.update(`${path}\0${text}\0`);
  }
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  const packages = Object.keys(deps)
    .filter((name) => /^@(fontsource|material-symbols)\//.test(name))
    .concat('@angular/material')
    .sort();
  const require = createRequire(new URL('package.json', root));
  for (const pkg of packages) {
    let version = '?';
    try {
      version = require(`${pkg}/package.json`).version;
    } catch {
      // Пакет не встановлено — у хеші лишається маркер.
    }
    hash.update(`${pkg}@${version}\0`);
  }
  return hash.digest('hex').slice(0, 12);
}

const config = {
  telegramBotUsername: get('NG_APP_TELEGRAM_BOT_USERNAME').replace(/^@/, ''),
  googleLogin: get('NG_APP_GOOGLE_LOGIN') === 'true',
  discordLogin: get('NG_APP_DISCORD_LOGIN') === 'true',
  devLogin: get('NG_APP_DEV_LOGIN') === 'true',
  deployEnv: ['dev', 'prod'].includes(get('NG_APP_DEPLOY_ENV'))
    ? get('NG_APP_DEPLOY_ENV')
    : 'local',
  themeStyleVersion: themeStyleVersion(),
};

const deployEnv = config.deployEnv;
/**
 * Режим dev-входу (build-time): local — форма на /login, beta — лише прихований маршрут /login/dev
 * за кодом тестера, off — dev-входу немає (прод або вимкнено). Експортується окремою константою-літералом,
 * щоб збірка відкидала недосяжний код (на проді в бандлі немає ні маршруту, ні ендпоінтів dev-входу).
 */
const devLoginMode = !config.devLogin
  ? 'off'
  : deployEnv === 'local'
    ? 'local'
    : deployEnv === 'dev'
      ? 'beta'
      : 'off';

/**
 * Маршрути dev-входу: лише в beta — прихований `/login/dev` (guestGuard, noindex). Імпорти guard-а й
 * компонента генеруються тільки в цій гілці, тож в інших збірках (зокрема prod) коду dev-входу
 * за кодом у бандлі немає взагалі, навіть окремим чанком.
 */
const devLoginRoutesSource =
  devLoginMode === 'beta'
    ? `import type { Routes } from '@angular/router';
import { guestGuard } from '../app/core/auth/auth.guards';

export const devLoginRoutes: Routes = [
  {
    path: 'login/dev',
    canActivate: [guestGuard],
    title: 'titles.devLogin',
    data: { noindex: true },
    loadComponent: () =>
      import('../app/features/auth/dev-code-login/dev-code-login').then((m) => m.DevCodeLogin),
  },
];
`
    : `import type { Routes } from '@angular/router';

export const devLoginRoutes: Routes = [];
`;

const source = `// Згенеровано scripts/gen-runtime-config.mjs — не редагуйте вручну (файл у .gitignore).
${devLoginRoutesSource}
export interface RuntimeConfig {
  /** Ім'я Telegram-бота для Login Widget; порожньо — віджет вимкнено. */
  readonly telegramBotUsername: string;
  /** Показувати вхід / прив'язку через Google. */
  readonly googleLogin: boolean;
  /** Показувати вхід / прив'язку через Discord. */
  readonly discordLogin: boolean;
  /** Показувати форму dev-входу. */
  readonly devLogin: boolean;
  /** Середовище розгортання (local, dev або prod); на dev показується банер «Тестове середовище». */
  readonly deployEnv: string;
  /** Версія бандлів стилів дизайнів для \`?v=\` (хеш вихідних стилів і пакетів шрифтів). */
  readonly themeStyleVersion: string;
}

export type DevLoginMode = 'local' | 'beta' | 'off';

/** Режим dev-входу: local — форма на /login; beta — прихований маршрут /login/dev; off — немає. */
export const devLoginMode: DevLoginMode = ${JSON.stringify(devLoginMode)};

export const runtimeConfig: RuntimeConfig = ${JSON.stringify(config, null, 2)};
`;

const prev = existsSync(out) ? readFileSync(out, 'utf8') : '';
if (prev !== source) {
  // У свіжому клоні (CI) теки ще немає — файл генерований і gitignored.
  mkdirSync(new URL('.', out), { recursive: true });
  writeFileSync(out, source);
}
console.log(`runtime-config: ${fileURLToPath(out)}`);
