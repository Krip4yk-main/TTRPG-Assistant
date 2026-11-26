import { z } from 'zod';
import type { NotificationParams } from './notifications.js';
import { POLL_VOTE_VALUES, type PollVoteValue } from './polls.js';

/**
 * Кнопка Telegram-сповіщення — структуровані дані; `callback_data` будує бот
 * (`a:<applicationId>:ok|no`, `r:<sessionId>:y|n`, `v:<optionId>:y|n|m`, ≤ 64 байт).
 * `vote` — відповідь на варіант голосування за час; `n` — номер варіанта (1…6) для підпису,
 * кнопки одного варіанта — окремий рядок клавіатури.
 */
export type TelegramButton =
  | { action: 'approve' | 'reject'; applicationId: number }
  | { action: 'rsvp'; sessionId: number; value: 'going' | 'not_going' }
  | { action: 'vote'; optionId: number; n: number; value: PollVoteValue };

/** Рядок `telegram_outbox`, виданий боту (`POST /api/internal/telegram/outbox/claim`). */
export interface TelegramOutboxItem {
  id: number;
  chatId: string;
  /** Тип сповіщення (`NotificationType`); текст — `notify.<kind>` у i18n бота. */
  kind: string;
  params: NotificationParams;
  buttons: TelegramButton[] | null;
  /** Скільки спроб уже було (видача рахується спробою). */
  attempts: number;
  /** IANA-пояс одержувача для дат у тексті; `null` — типовий (Europe/Kyiv). */
  timeZone: string | null;
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
    /**
     * Telegram 429 (або решта пачки після нього): спроба не рахується — видачу, що її
     * зарахувала, відкочуємо (`attempts - 1`), повтор не раніше `retryAfterSec`.
     */
    rateLimited: z.boolean().optional(),
  })
  .strict();
export type TelegramOutboxFailedInput = z.input<typeof telegramOutboxFailedSchema>;

/** Дії з кнопок Telegram-сповіщень. */
export const TELEGRAM_ACTIONS = ['approve', 'reject', 'rsvp', 'vote'] as const;
export type TelegramAction = (typeof TELEGRAM_ACTIONS)[number];

/** Тіло `POST /api/internal/telegram/action` (бот → бекенд). */
export const telegramActionSchema = z
  .object({
    telegramId: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().positive()]),
    action: z.enum(TELEGRAM_ACTIONS),
    id: z.number().int().positive(),
    /** `rsvp` — going/not_going; `vote` — yes/no/maybe (id — варіант голосування). */
    value: z.enum(['going', 'not_going', ...POLL_VOTE_VALUES]).optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.action === 'rsvp'
        ? b.value === 'going' || b.value === 'not_going'
        : b.action === 'vote'
          ? (POLL_VOTE_VALUES as readonly string[]).includes(b.value ?? '')
          : b.value === undefined,
    { message: 'value must match the action', path: ['value'] },
  );
export type TelegramActionInput = z.input<typeof telegramActionSchema>;

/** Успішна відповідь `POST /api/internal/telegram/action`. */
export interface TelegramActionResult {
  ok: true;
  result: 'approved' | 'rejected' | 'going' | 'not_going' | 'vote_yes' | 'vote_no' | 'vote_maybe';
}
