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
    ...(parsed.action === 'rsvp' ? { value: parsed.value } : {}),
  });
  if (!outcome.ok) {
    const key = `actions.errors.${outcome.code}`;
    const msg = t(key);
    await ctx.answerCallbackQuery({ text: msg === key ? t('actions.errors.default') : msg });
    return;
  }
  const status = t(`actions.done.${outcome.result}`);
  await ctx.answerCallbackQuery({ text: status });
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
