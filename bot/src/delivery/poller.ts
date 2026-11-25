import { GrammyError, HttpError } from 'grammy';
import type { TelegramOutboxFailedInput, TelegramOutboxItem } from '@nri/shared';
import { BackendError, type BackendClient } from '../api/backend-client.js';
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
  /** Годинник (для тестів). */
  now?: () => Date;
};

/**
 * Стан між циклами: id, які вже надіслано в Telegram, але звіт `sent` не дійшов до бекенда.
 * Кожен цикл спершу повторює ці звіти; якщо такий рядок видано знову (лок сплив) — не
 * надсилаємо вдруге, лише звітуємо.
 */
export type DeliveryState = { unreportedSent: Set<number> };

export const newDeliveryState = (): DeliveryState => ({ unreportedSent: new Set() });

/** Межа пам'яті для незвітованих id (бекенд недоступний довго — далі можливий дубль). */
const UNREPORTED_MAX = 10_000;

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
        ? { retryable: true, rateLimited: true, retryAfterSec: Math.ceil(after), error }
        : { retryable: true, rateLimited: true, error };
    }
    return { retryable: true, error };
  }
  // Лише тип/назва: у тексті мережевої помилки може бути URL з токеном бота.
  if (err instanceof HttpError) return { retryable: true, error: 'network error' };
  return { retryable: true, error: err instanceof Error ? err.name : 'unknown error' };
}

const errName = (err: unknown): string => (err instanceof Error ? err.message : 'unknown');

/** Нагадування про сесію, що вже почалась, — неактуальне. */
function isStale(item: TelegramOutboxItem, now: Date): boolean {
  if (item.kind !== 'session.reminder' || !item.params.startsAt) return false;
  const t = Date.parse(item.params.startsAt);
  return Number.isFinite(t) && t < now.getTime();
}

/**
 * Один цикл: спершу повторити незвітовані `sent`, потім забрати пачку й надіслати кожне
 * повідомлення простим текстом (без `parse_mode`), звітуючи `sent` / `failed`.
 * - Помилка рендеру — остаточна (`retryable: false`), без спроби надіслати.
 * - Нагадування про сесію, що вже почалась, — `failed 'stale'` без надсилання.
 * - Telegram 429 — пачка зупиняється: це й решта повідомлень звітуються як `rateLimited`
 *   (спроба не рахується) з тим самим `retryAfterSec`.
 * - Збій звіту `sent` — id запам'ятовується (`state.unreportedSent`), щоб не надіслати
 *   вдруге; збій звіту `failed` лише логується (лок спливе — повтор).
 */
export async function deliverOnce(
  deps: PollerDeps,
  batch = CLAIM_BATCH,
  state: DeliveryState = newDeliveryState(),
): Promise<number> {
  const log = deps.log ?? ((m: string) => console.error(m));
  const now = (deps.now ?? (() => new Date()))();

  const reportSent = async (id: number): Promise<void> => {
    try {
      await deps.client.markSent(id);
      state.unreportedSent.delete(id);
    } catch (err) {
      // Рядка вже немає (очищено) — звітувати нікуди.
      if (err instanceof BackendError && err.status === 404) {
        state.unreportedSent.delete(id);
        return;
      }
      if (state.unreportedSent.size < UNREPORTED_MAX) state.unreportedSent.add(id);
      log(`outbox ${id}: report failed (${errName(err)})`);
    }
  };
  const reportFailed = async (id: number, failure: TelegramOutboxFailedInput): Promise<void> => {
    try {
      await deps.client.markFailed(id, failure);
    } catch (err) {
      log(`outbox ${id}: report failed (${errName(err)})`);
    }
  };

  for (const id of [...state.unreportedSent]) await reportSent(id);

  const items = await deps.client.claimOutbox(batch);
  let rateLimit: TelegramOutboxFailedInput | null = null;
  for (const item of items) {
    if (rateLimit) {
      await reportFailed(item.id, rateLimit);
      continue;
    }
    if (state.unreportedSent.has(item.id)) {
      await reportSent(item.id);
      continue;
    }
    if (isStale(item, now)) {
      await reportFailed(item.id, { retryable: false, error: 'stale' });
      continue;
    }
    let r: Rendered;
    try {
      r = deps.render(item);
    } catch (err) {
      await reportFailed(item.id, {
        retryable: false,
        error: `render error: ${err instanceof Error ? err.name : 'unknown'}`,
      });
      continue;
    }
    try {
      await deps.api.sendMessage(item.chatId, r.text, {
        ...(r.keyboard ? { reply_markup: { inline_keyboard: r.keyboard } } : {}),
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      const failure = classifySendError(err);
      if (failure.rateLimited) {
        rateLimit = {
          retryable: true,
          rateLimited: true,
          error: 'rate limited',
          ...(failure.retryAfterSec !== undefined ? { retryAfterSec: failure.retryAfterSec } : {}),
        };
      }
      await reportFailed(item.id, failure);
      continue;
    }
    await reportSent(item.id);
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
  const state = newDeliveryState();

  const tick = (): Promise<void> => {
    if (current || stopped) return current ?? Promise.resolve();
    current = deliverOnce(deps, opts.batch, state)
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
