import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Bot } from 'grammy';
import { createBackendClient } from './api/backend-client.js';
import type { BackendClient } from './api/backend-client.js';
import { loadEnv } from './config/env.js';
import uk from './i18n/uk.json' with { type: 'json' };

export type Translate = (key: string, vars?: Record<string, string>) => string;

/** Мінімум від grammY-контексту, потрібний обробнику (спрощує тести). */
export type StartCtx = {
  match: string;
  from?: { id: number; username?: string; first_name: string };
  reply(text: string): Promise<unknown>;
};

export function makeT(dict: Record<string, unknown> = uk): Translate {
  return (key, vars = {}) => {
    let node: unknown = dict;
    for (const part of key.split('.')) node = (node as Record<string, unknown> | undefined)?.[part];
    if (typeof node !== 'string') return key;
    return node.replace(/\{(\w+)\}/g, (m, name: string) => vars[name] ?? m);
  };
}

/** `/start` без токена — привітання; `/start <token>` — прив'язка Telegram до акаунта. */
export async function handleStart(
  ctx: StartCtx,
  client: BackendClient,
  t: Translate,
): Promise<void> {
  const token = ctx.match.trim();
  if (!token || !ctx.from) {
    await ctx.reply(t('start.welcome'));
    return;
  }
  const result = await client.linkTelegram(
    token,
    ctx.from.id,
    ctx.from.username ?? ctx.from.first_name,
  );
  if (result.ok) {
    await ctx.reply(t('link.success', { nickname: result.nickname }));
  } else {
    await ctx.reply(t(`link.${result.reason}`));
  }
}

export async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const env = loadEnv();
  const client = createBackendClient(env.BACKEND_INTERNAL_URL, env.INTERNAL_API_KEY);
  const t = makeT();
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  bot.command('start', (ctx) => handleStart(ctx, client, t));
  bot.catch((err) => {
    // Лише тип помилки: у повідомленнях/URL може бути токен.
    console.error(
      'Помилка обробки оновлення:',
      err.error instanceof Error ? err.error.name : 'unknown',
    );
  });
  const stop = (): void => void bot.stop();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await bot.start({ onStart: (me) => console.log(`Бот @${me.username} запущено (long polling)`) });
}

// Запуск лише коли файл виконується напряму (не під час імпорту в тестах).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : 'Не вдалося запустити бота');
    process.exit(1);
  });
}
