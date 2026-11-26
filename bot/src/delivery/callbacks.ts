import type { TelegramActionResult } from '@nri/shared';
import type { BackendClient } from '../api/backend-client.js';
import type { Translate } from '../i18n/t.js';
import { parseCallback } from './callback-data.js';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { TELEGRAM_TEXT_MAX } from './render.js';

type Keyboard = InlineKeyboardMarkup;

/** Мінімум від grammY-контексту `callback_query`, потрібний обробнику (спрощує тести). */
export type CallbackCtx = {
  callbackQuery: {
    data?: string;
    from: { id: number };
    /** Відсутнє, якщо повідомлення недоступне (старіше 48 год тощо). */
    message?: { text?: string; reply_markup?: Keyboard };
  };
  answerCallbackQuery(other?: { text?: string }): Promise<unknown>;
  editMessageText(
    text: string,
    other: { reply_markup?: Keyboard; link_preview_options?: { is_disabled: boolean } },
  ): Promise<unknown>;
};

const RESULTS: TelegramActionResult['result'][] = ['approved', 'rejected', 'going', 'not_going'];

/** Повідомлення без попереднього рядка-статусу (RSVP можна змінювати — рядок замінюється). */
function stripStatus(text: string, t: Translate): string {
  for (const r of RESULTS) {
    const suffix = `\n\n${t(`actions.done.${r}`)}`;
    if (text.endsWith(suffix)) return text.slice(0, -suffix.length);
  }
  return text;
}

/**
 * Натискання кнопки сповіщення: розбирає `callback_data`, виконує дію на бекенді від імені
 * того, хто натиснув (права перевіряє бекенд), відповідає коротким текстом. Після успіху
 * дописує в повідомлення рядок-статус: для заявки клавіатура прибирається, для RSVP —
 * лишається (відповідь можна змінити). Помилка — лише відповідь з перекладеною причиною.
 * Чужі чи зіпсовані дані — тиха відповідь (щоб у клієнта зник «годинник»). Без `parse_mode`.
 */
export async function handleCallback(
  ctx: CallbackCtx,
  client: Pick<BackendClient, 'telegramAction'>,
  t: Translate,
  log: (msg: string) => void = (m) => console.error(m),
): Promise<void> {
  const q = ctx.callbackQuery;
  const parsed = q.data ? parseCallback(q.data) : null;
  if (!parsed) {
    await ctx.answerCallbackQuery();
    return;
  }
  const outcome = await client.telegramAction({
    telegramId: q.from.id,
    action: parsed.action,
    id: parsed.id,
    ...(parsed.action === 'rsvp' || parsed.action === 'vote' ? { value: parsed.value } : {}),
  });
  if (!outcome.ok) {
    const key = `actions.errors.${outcome.code}`;
    const msg = t(key);
    await ctx.answerCallbackQuery({ text: msg === key ? t('actions.errors.default') : msg });
    return;
  }
  const status = t(`actions.done.${outcome.result}`);
  await ctx.answerCallbackQuery({ text: status });
  if (parsed.action === 'vote') {
    await markVote(ctx, q.data!, log);
    return;
  }
  const original = q.message?.text;
  if (original === undefined) return;
  const suffix = `\n\n${status}`;
  let base = stripStatus(original, t);
  const room = TELEGRAM_TEXT_MAX - suffix.length;
  if (base.length > room) base = `${base.slice(0, room - 1)}…`;
  const text = `${base}${suffix}`;
  const keep = parsed.action === 'rsvp' && q.message?.reply_markup;
  if (text === original) return; // те саме RSVP вдруге — Telegram відхилив би «not modified»
  try {
    await ctx.editMessageText(text, {
      reply_markup: keep ? q.message!.reply_markup! : { inline_keyboard: [] },
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    // Дію виконано; невдале редагування (повідомлення видалено тощо) — не помилка для користувача.
    log(`callback edit failed (${err instanceof Error ? err.name : 'unknown'})`);
  }
}

/** Позначка обраної відповіді на кнопці голосування. */
export const VOTE_MARK = '✔️ ';

/**
 * Голосування: текст лишається, у клавіатурі позначається обрана відповідь (`VOTE_MARK`) у
 * рядку цього варіанта (з інших кнопок рядка позначка знімається). Та сама відповідь удруге —
 * без редагування (Telegram відхилив би «not modified»).
 */
async function markVote(ctx: CallbackCtx, data: string, log: (msg: string) => void): Promise<void> {
  const q = ctx.callbackQuery;
  const markup = q.message?.reply_markup;
  const text = q.message?.text;
  if (!markup || text === undefined) return;
  const prefix = data.slice(0, data.lastIndexOf(':') + 1);
  let changed = false;
  const inline_keyboard = markup.inline_keyboard.map((row) => {
    if (!row.some((b) => 'callback_data' in b && b.callback_data === data)) return row;
    return row.map((b) => {
      if (!('callback_data' in b) || !b.callback_data?.startsWith(prefix)) return b;
      const base = b.text.startsWith(VOTE_MARK) ? b.text.slice(VOTE_MARK.length) : b.text;
      const next = b.callback_data === data ? `${VOTE_MARK}${base}` : base;
      if (next !== b.text) changed = true;
      return { ...b, text: next };
    });
  });
  if (!changed) return;
  try {
    await ctx.editMessageText(text, {
      reply_markup: { inline_keyboard },
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    log(`callback edit failed (${err instanceof Error ? err.name : 'unknown'})`);
  }
}
