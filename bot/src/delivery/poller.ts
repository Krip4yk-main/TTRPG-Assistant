import { GrammyError, HttpError } from 'grammy';
import type { TelegramOutboxFailedInput, TelegramOutboxItem } from '@nri/shared';
import type { BackendClient } from '../api/backend-client.js';
import type { Rendered } from './render.js';

export const POLL_EVERY_MS = 3000;
export const CLAIM_BATCH = 20;

/** Мінімум від `bot.api`, потрібний доставці (спрощує тести). */
export type SendApi = {
  sendMessage(
    chatId: string,
    text: string,
    other: {
      reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
      link_preview_options?: { is_disabled: boolean };
    },
  ): Promise<unknown>;
};

export type PollerDeps = {
  client: Pick<BackendClient, 'claimOutbox' | 'markSent' | 'markFailed'>;
  api: SendApi;
  render: (item: TelegramOutboxItem) => Rendered;
  log?: (msg: string) => void;
};

export type PollerOptions = { intervalMs?: number; batch?: number };

/**
 * Класифікація помилки `sendMessage`:
 * 403 (бот заблокований, акаунт деактивовано) і 400 «chat not found» — остаточні, чат
 * недосяжний; інші 400 — остаточні для цього повідомлення; 429 — повтор не раніше
 * `retry_after`; 5xx, мережа, невідоме — тимчасові.
 */
export function classifySendError(err: unknown): TelegramOutboxFailedInput {
  if (err instanceof GrammyError) {
    const error = `${err.error_code}: ${err.description}`;
    if (err.error_code === 403) return { retryable: false, chatUnreachable: true, error };
    if (err.error_code === 400) {
      return /chat not found|user not found/i.test(err.description)
        ? { retryable: false, chatUnreachable: true, error }
        : { retryable: false, error };
    }
    if (err.error_code === 429) {
      const after = err.parameters?.retry_after;
      return typeof after === 'number'
        ? { retryable: true, retryAfterSec: Math.ceil(after), error }
        : { retryable: true, error };
    }
    return { retryable: true, error };
  }
  // Лише тип/назва: у тексті мережевої помилки може бути URL з токеном бота.
  if (err instanceof HttpError) return { retryable: true, error: 'network error' };
  return { retryable: true, error: err instanceof Error ? err.name : 'unknown error' };
}

/**
 * Один цикл: забрати пачку, надіслати кожне повідомлення простим текстом (без `parse_mode`),
 * звітувати `sent` / `failed`. Збій звіту лише логується — лок спливе, і повідомлення
 * повториться (можливий рідкісний дубль, але не втрата).
 */
export async function deliverOnce(deps: PollerDeps, batch = CLAIM_BATCH): Promise<number> {
  const log = deps.log ?? ((m: string) => console.error(m));
  const items = await deps.client.claimOutbox(batch);
  for (const item of items) {
    let outcome: { sent: true } | { sent: false; failure: TelegramOutboxFailedInput };
    try {
      const r = deps.render(item);
      await deps.api.sendMessage(item.chatId, r.text, {
        ...(r.keyboard ? { reply_markup: { inline_keyboard: r.keyboard } } : {}),
        link_preview_options: { is_disabled: true },
      });
      outcome = { sent: true };
    } catch (err) {
      outcome = { sent: false, failure: classifySendError(err) };
    }
    try {
      if (outcome.sent) await deps.client.markSent(item.id);
      else await deps.client.markFailed(item.id, outcome.failure);
    } catch (err) {
      log(`outbox ${item.id}: report failed (${err instanceof Error ? err.message : 'unknown'})`);
    }
  }
  return items.length;
}

export type Poller = {
  /** Один цикл; якщо попередній ще йде — нічого не робить (без накладання). */
  tick(): Promise<void>;
  /** Зупиняє таймер і чекає завершення поточного циклу. */
  stop(): Promise<void>;
};

/** Опитування черги кожні `intervalMs` (наступний цикл — лише після завершення попереднього). */
export function startPoller(deps: PollerDeps, opts: PollerOptions = {}): Poller {
  const intervalMs = opts.intervalMs ?? POLL_EVERY_MS;
  const log = deps.log ?? ((m: string) => console.error(m));
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> | null = null;

  const tick = (): Promise<void> => {
    if (current || stopped) return current ?? Promise.resolve();
    current = deliverOnce(deps, opts.batch)
      .then(
        () => undefined,
        (err: unknown) => {
          log(`outbox poll failed (${err instanceof Error ? err.message : 'unknown'})`);
        },
      )
      .finally(() => {
        current = null;
      });
    return current;
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().then(schedule);
    }, intervalMs);
  };
  schedule();

  return {
    tick,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    },
  };
}
