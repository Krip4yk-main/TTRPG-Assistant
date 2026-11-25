import { and, asc, eq, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import {
  defaultNotificationPrefs,
  telegramOutboxClaimSchema,
  telegramOutboxFailedSchema,
  type NotificationCategory,
  type TelegramButton,
  type TelegramOutboxItem,
} from '@nri/shared';
import type { Tx } from '../applications/applications.rules.js';
import type { Db } from '../db/client.js';
import { authIdentities, notificationPrefs, telegramOutbox } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';

type DbLike = Db | Tx;

/** Мінімум рядка сповіщення, потрібний для постановки в Telegram-чергу. */
export type OutboxSource = {
  id: number;
  userId: number;
  type: string;
  category: NotificationCategory;
  payload: TelegramOutboxItem['params'];
};

export const OUTBOX_LOCK_MS = 2 * 60_000;
export const OUTBOX_MAX_ATTEMPTS = 5;
const OUTBOX_BACKOFF_BASE_MS = 30_000;
const LAST_ERROR_MAX = 255;
const DAY_MS = 86_400_000;
export const OUTBOX_TTL_DAYS = 30;
const PURGE_BATCH = 1000;

/** Затримка після невдалої спроби №`attempts` (з 1): 30 с · 2^(attempts-1). */
export const outboxBackoffMs = (attempts: number): number =>
  OUTBOX_BACKOFF_BASE_MS * 2 ** (attempts - 1);

/** Кнопки за типом сповіщення: заявка — майстру «Затвердити/Відхилити»; нагадування — RSVP. */
export function buttonsFor(n: Pick<OutboxSource, 'type' | 'payload'>): TelegramButton[] | null {
  const p = n.payload;
  if (n.type === 'application.created' && p.applicationId !== undefined) {
    return [
      { action: 'approve', applicationId: p.applicationId },
      { action: 'reject', applicationId: p.applicationId },
    ];
  }
  if (n.type === 'session.reminder' && p.sessionId !== undefined) {
    return [
      { action: 'rsvp', sessionId: p.sessionId, value: 'going' },
      { action: 'rsvp', sessionId: p.sessionId, value: 'not_going' },
    ];
  }
  return null;
}

/**
 * Ставить Telegram-повідомлення для нових сповіщень: лише користувачам із Telegram-ідентичністю
 * та ввімкненою категорією (`prefs.telegram[category] !== false`). Два пакетні запити (ідентичності,
 * налаштування), одна вставка; повтор того самого сповіщення — no-op (UNIQUE notification_id).
 * Лише записи через `tx`, без мережі.
 */
export async function enqueueTelegram(tx: DbLike, rows: OutboxSource[]): Promise<number> {
  if (rows.length === 0) return 0;
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const idents = await tx
    .select({ userId: authIdentities.userId, subject: authIdentities.subject })
    .from(authIdentities)
    .where(and(eq(authIdentities.provider, 'telegram'), inArray(authIdentities.userId, userIds)));
  if (idents.length === 0) return 0;
  const chatOf = new Map(idents.map((i) => [i.userId, i.subject]));
  const prefRows = await tx
    .select({ userId: notificationPrefs.userId, telegram: notificationPrefs.telegram })
    .from(notificationPrefs)
    .where(inArray(notificationPrefs.userId, [...chatOf.keys()]));
  const defaults = defaultNotificationPrefs().telegram;
  const prefsOf = new Map(prefRows.map((p) => [p.userId, { ...defaults, ...p.telegram }]));
  const values = rows.flatMap((r) => {
    const chatId = chatOf.get(r.userId);
    if (chatId === undefined) return [];
    if ((prefsOf.get(r.userId) ?? defaults)[r.category] === false) return [];
    return [
      {
        notificationId: r.id,
        userId: r.userId,
        chatId,
        kind: r.type,
        params: r.payload,
        buttons: buttonsFor(r),
      },
    ];
  });
  if (values.length === 0) return 0;
  await tx
    .insert(telegramOutbox)
    .values(values)
    .onDuplicateKeyUpdate({ set: { id: sql`${telegramOutbox.id}` } });
  return values.length;
}

const toItem = (r: typeof telegramOutbox.$inferSelect): TelegramOutboxItem => ({
  id: r.id,
  chatId: r.chatId,
  kind: r.kind,
  params: r.params,
  buttons: r.buttons ?? null,
  attempts: r.attempts,
});

/**
 * Видає боту пачку повідомлень, що настали (`pending`, `next_try_at <= now`, без живого локу —
 * зокрема й ті, чий лок прострочено, бо бот «упав»), і ставить `locked_until = now + 2 хв`.
 * Коротка транзакція READ COMMITTED з `FOR UPDATE SKIP LOCKED`: паралельні виклики не
 * отримують той самий рядок.
 */
export async function claimOutbox(
  deps: { db: Db },
  body: unknown,
  now: Date = new Date(),
): Promise<TelegramOutboxItem[]> {
  const { limit } = telegramOutboxClaimSchema.parse(body ?? {});
  const lockedUntil = new Date(now.getTime() + OUTBOX_LOCK_MS);
  return deps.db.transaction(
    async (tx) => {
      const rows = await tx
        .select()
        .from(telegramOutbox)
        .where(
          and(
            eq(telegramOutbox.status, 'pending'),
            lte(telegramOutbox.nextTryAt, now),
            or(isNull(telegramOutbox.lockedUntil), lt(telegramOutbox.lockedUntil, now)),
          ),
        )
        // FIFO за id: без filesort InnoDB блокує лише видані рядки (LIMIT), а не всі, що настали.
        .orderBy(asc(telegramOutbox.id))
        .limit(limit)
        .for('update', { skipLocked: true });
      if (rows.length === 0) return [];
      await tx
        .update(telegramOutbox)
        .set({ lockedUntil })
        .where(
          inArray(
            telegramOutbox.id,
            rows.map((r) => r.id),
          ),
        );
      return rows.map(toItem);
    },
    { isolationLevel: 'read committed' },
  );
}

async function existsOr404(db: Db, id: number): Promise<void> {
  const [row] = await db
    .select({ id: telegramOutbox.id })
    .from(telegramOutbox)
    .where(eq(telegramOutbox.id, id));
  if (!row) throw new AppError(404, 'NOT_FOUND');
}

/** Позначає надісланим (ідемпотентно). Невідомий id — 404. */
export async function markOutboxSent(deps: { db: Db }, id: number): Promise<void> {
  await existsOr404(deps.db, id);
  await deps.db
    .update(telegramOutbox)
    .set({ status: 'sent', lockedUntil: null, lastError: null })
    .where(eq(telegramOutbox.id, id));
}

/**
 * Невдала спроба. `retryable` — `attempts + 1` і повтор через 30 с · 2^(n-1) (не раніше за
 * `retryAfterSec`); на 5-й невдачі — `failed`. Не `retryable` — одразу `failed`. Змінює лише
 * `pending`-рядок (уже надісланий не «псується»). `chatUnreachable` — бот заблоковано / чат
 * не знайдено: інші очікувані й не видані зараз повідомлення цього чату теж `failed` (нові,
 * поставлені пізніше, знову спробуються — користувач міг розблокувати бота).
 */
export async function markOutboxFailed(
  deps: { db: Db },
  id: number,
  body: unknown,
  now: Date = new Date(),
): Promise<void> {
  const input = telegramOutboxFailedSchema.parse(body);
  const lastError = (input.error ?? (input.retryable ? 'retryable error' : 'failed')).slice(
    0,
    LAST_ERROR_MAX,
  );
  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(telegramOutbox)
      .where(eq(telegramOutbox.id, id))
      .for('update');
    if (!row) throw new AppError(404, 'NOT_FOUND');
    if (row.status !== 'pending') return;
    const attempts = row.attempts + 1;
    if (input.retryable && attempts < OUTBOX_MAX_ATTEMPTS) {
      const delay = Math.max(outboxBackoffMs(attempts), (input.retryAfterSec ?? 0) * 1000);
      await tx
        .update(telegramOutbox)
        .set({ attempts, nextTryAt: new Date(now.getTime() + delay), lockedUntil: null, lastError })
        .where(eq(telegramOutbox.id, id));
      return;
    }
    await tx
      .update(telegramOutbox)
      .set({ status: 'failed', attempts, lockedUntil: null, lastError })
      .where(eq(telegramOutbox.id, id));
    if (!input.retryable && input.chatUnreachable) {
      await tx
        .update(telegramOutbox)
        .set({ status: 'failed', lockedUntil: null, lastError: 'chat unreachable' })
        .where(
          and(
            eq(telegramOutbox.chatId, row.chatId),
            eq(telegramOutbox.status, 'pending'),
            ne(telegramOutbox.id, id),
            or(isNull(telegramOutbox.lockedUntil), lt(telegramOutbox.lockedUntil, now)),
          ),
        );
    }
  });
}

/** Надіслані й невдалі повідомлення, старші 30 днів (за `updated_at`), пачками по 1000. */
export async function purgeTelegramOutbox(
  deps: { db: Db },
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - OUTBOX_TTL_DAYS * DAY_MS);
  let total = 0;
  for (;;) {
    const [res] = await deps.db
      .delete(telegramOutbox)
      .where(
        and(
          inArray(telegramOutbox.status, ['sent', 'failed']),
          lt(telegramOutbox.updatedAt, cutoff),
        ),
      )
      .limit(PURGE_BATCH);
    total += res.affectedRows;
    if (res.affectedRows < PURGE_BATCH) return total;
  }
}
