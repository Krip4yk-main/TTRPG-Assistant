import { z } from 'zod';
import type { NotificationParams } from './notifications.js';

/**
 * Кнопка Telegram-сповіщення — структуровані дані; `callback_data` будує бот
 * (`a:<applicationId>:ok|no`, `r:<sessionId>:y|n`, ≤ 64 байт).
 */
export type TelegramButton =
  | { action: 'approve' | 'reject'; applicationId: number }
  | { action: 'rsvp'; sessionId: number; value: 'going' | 'not_going' };

/** Рядок `telegram_outbox`, виданий боту (`POST /api/internal/telegram/outbox/claim`). */
export interface TelegramOutboxItem {
  id: number;
  chatId: string;
  /** Тип сповіщення (`NotificationType`); текст — `notify.<kind>` у i18n бота. */
  kind: string;
  params: NotificationParams;
  buttons: TelegramButton[] | null;
  /** Скільки невдалих спроб уже було. */
  attempts: number;
}

export interface TelegramOutboxClaimResult {
  items: TelegramOutboxItem[];
}

export const TELEGRAM_OUTBOX_CLAIM_MAX = 50;

export const telegramOutboxClaimSchema = z
  .object({
    limit: z.number().int().min(1).max(TELEGRAM_OUTBOX_CLAIM_MAX).default(20),
  })
  .strict();

/** Тіло `POST /api/internal/telegram/outbox/:id/failed`. */
export const telegramOutboxFailedSchema = z
  .object({
    /** true — тимчасова помилка (мережа, 5xx, 429): повтор із затримкою; false — одразу `failed`. */
    retryable: z.boolean(),
    error: z.string().max(1000).optional(),
    /** Telegram 429 `retry_after`, секунди — мінімальна затримка повтору. */
    retryAfterSec: z.number().int().min(0).max(86_400).optional(),
    /**
     * Чат недосяжний (бот заблокований, акаунт видалено, chat not found): інші очікувані
     * повідомлення цього чату теж позначаються `failed`, щоб не стукати марно.
     */
    chatUnreachable: z.boolean().optional(),
  })
  .strict();
export type TelegramOutboxFailedInput = z.input<typeof telegramOutboxFailedSchema>;
