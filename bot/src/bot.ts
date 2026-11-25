import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Bot } from 'grammy';
import { createBackendClient } from './api/backend-client.js';
import type { BackendClient } from './api/backend-client.js';
import { loadEnv } from './config/env.js';
import { startPoller } from './delivery/poller.js';
import { renderNotification } from './delivery/render.js';
import { makeT, type Translate } from './i18n/t.js';

export { makeT, type Translate };

/** Мінімум від grammY-контексту, потрібний обробнику (спрощує тести). */
export type StartCtx = {
  match: string;
  from?: { id: number; username?: string; first_name: string };
  reply(text: string): Promise<unknown>;
};

/** `/start` без токена — привітання; `/start <token>` — прив'язка Telegram до акаунта. */
export async function handleStart(
  ctx: StartCtx,
  client: Pick<BackendClient, 'linkTelegram'>,
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
  // Доставка сповіщень: опитування черги бекенда кожні 3 с.
  const poller = startPoller({
    client,
    api: bot.api,
    render: (item) =>
      renderNotification(item.kind, item.params, item.buttons, {
        siteUrl: env.PUBLIC_BASE_URL,
        t,
      }),
  });
  const stop = (): void => {
    void poller.stop().finally(() => void bot.stop());
  };
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
