import { and, asc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
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
import {
  authIdentities,
  games,
  notificationPrefs,
  telegramOutbox,
  users,
} from '../db/schema/index.js';
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
/** Не надіслане за добу вже неактуальне (нагадування, кнопки заявки) → `failed 'stale'`. */
export const OUTBOX_STALE_MS = DAY_MS;
const PURGE_BATCH = 1000;

/** Затримка після невдалої спроби №`attempts` (з 1): 30 с · 2^(attempts-1). */
export const outboxBackoffMs = (attempts: number): number =>
  OUTBOX_BACKOFF_BASE_MS * 2 ** (attempts - 1);

/**
 * Кнопки за типом сповіщення: заявка — майстру «Затвердити/Відхилити»; нагадування — RSVP
 * (лише учасникам: майстер на власну сесію не відповідає, `recipientIsGm` — без кнопок).
 */
export function buttonsFor(
  n: Pick<OutboxSource, 'type' | 'payload'>,
  recipientIsGm = false,
): TelegramButton[] | null {
  const p = n.payload;
  if (n.type === 'application.created' && p.applicationId !== undefined) {
    return [
      { action: 'approve', applicationId: p.applicationId },
      { action: 'reject', applicationId: p.applicationId },
    ];
  }
  if (n.type === 'session.reminder' && p.sessionId !== undefined && !recipientIsGm) {
    return [
      { action: 'rsvp', sessionId: p.sessionId, value: 'going' },
      { action: 'rsvp', sessionId: p.sessionId, value: 'not_going' },
    ];
  }
  return null;
}

/**
 * Ставить Telegram-повідомлення для нових сповіщень: лише користувачам із Telegram-ідентичністю
 * та ввімкненою категорією (`prefs.telegram[category] !== false`). Два пакетні запити (ідентичності
 * з поясом користувача, налаштування), одна вставка; повтор того самого сповіщення — no-op
 * (UNIQUE notification_id). Лише записи через `tx`, без мережі.
 */
export async function enqueueTelegram(tx: DbLike, rows: OutboxSource[]): Promise<number> {
  if (rows.length === 0) return 0;
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const idents = await tx
    .select({
      userId: authIdentities.userId,
      subject: authIdentities.subject,
      timeZone: users.timezone,
    })
    .from(authIdentities)
    .innerJoin(users, eq(users.id, authIdentities.userId))
    .where(and(eq(authIdentities.provider, 'telegram'), inArray(authIdentities.userId, userIds)));
  if (idents.length === 0) return 0;
  const chatOf = new Map(idents.map((i) => [i.userId, i.subject]));
  const zoneOf = new Map(idents.map((i) => [i.userId, i.timeZone]));
  const prefRows = await tx
    .select({ userId: notificationPrefs.userId, telegram: notificationPrefs.telegram })
    .from(notificationPrefs)
    .where(inArray(notificationPrefs.userId, [...chatOf.keys()]));
  const defaults = defaultNotificationPrefs().telegram;
  const prefsOf = new Map(prefRows.map((p) => [p.userId, { ...defaults, ...p.telegram }]));
  // Майстри ігор нагадувань: їм — без RSVP-кнопок.
  const reminderGameIds = [
    ...new Set(
      rows.flatMap((r) =>
        r.type === 'session.reminder' && r.payload.gameId !== undefined ? [r.payload.gameId] : [],
      ),
    ),
  ];
  const gmOf = new Map<number, number>();
  if (reminderGameIds.length > 0) {
    const gameRows = await tx
      .select({ id: games.id, gmUserId: games.gmUserId })
      .from(games)
      .where(inArray(games.id, reminderGameIds));
    for (const g of gameRows) gmOf.set(g.id, g.gmUserId);
  }
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
        buttons: buttonsFor(
          r,
          r.payload.gameId !== undefined && gmOf.get(r.payload.gameId) === r.userId,
        ),
        timeZone: zoneOf.get(r.userId) ?? null,
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
  timeZone: r.timeZone ?? null,
});

/**
 * Видає боту пачку повідомлень, що настали (`pending`, `next_try_at <= now`, без живого локу —
 * зокрема й ті, чий лок прострочено, бо бот «упав»), і ставить `locked_until = now + 2 хв`.
 * Видача рахується спробою (`attempts + 1`): рядок, на якому бот щоразу падає без звіту, не
 * крутиться вічно — після 5 видач він `failed 'lock expired'`. Не надіслане за добу —
 * `failed 'stale'`. Рядок, чий `chat_id` уже не є Telegram-ідентичністю користувача, —
 * `failed 'unlinked'` (не видається). Коротка транзакція READ COMMITTED з `FOR UPDATE SKIP LOCKED`: паралельні
 * виклики не отримують той самий рядок.
 */
export async function claimOutbox(
  deps: { db: Db },
  body: unknown,
  now: Date = new Date(),
): Promise<TelegramOutboxItem[]> {
  const { limit } = telegramOutboxClaimSchema.parse(body ?? {});
  const lockedUntil = new Date(now.getTime() + OUTBOX_LOCK_MS);
  const staleBefore = new Date(now.getTime() - OUTBOX_STALE_MS);
  const idle = () => or(isNull(telegramOutbox.lockedUntil), lt(telegramOutbox.lockedUntil, now));
  return deps.db.transaction(
    async (tx) => {
      // Вичерпані видачі з простроченим локом (бот не звітував) і застарілі — остаточно.
      await tx
        .update(telegramOutbox)
        .set({ status: 'failed', lockedUntil: null, lastError: 'lock expired' })
        .where(
          and(
            eq(telegramOutbox.status, 'pending'),
            gte(telegramOutbox.attempts, OUTBOX_MAX_ATTEMPTS),
            idle(),
          ),
        );
      await tx
        .update(telegramOutbox)
        .set({ status: 'failed', lockedUntil: null, lastError: 'stale' })
        .where(
          and(
            eq(telegramOutbox.status, 'pending'),
            lt(telegramOutbox.createdAt, staleBefore),
            idle(),
          ),
        );
      const rows = await tx
        .select()
        .from(telegramOutbox)
        .where(
          and(
            eq(telegramOutbox.status, 'pending'),
            lte(telegramOutbox.nextTryAt, now),
            idle(),
            lt(telegramOutbox.attempts, OUTBOX_MAX_ATTEMPTS),
            gte(telegramOutbox.createdAt, staleBefore),
          ),
        )
        // FIFO за id (індекс (status, id)): без filesort InnoDB блокує лише видані рядки
        // (LIMIT), а не всі, що настали.
        .orderBy(asc(telegramOutbox.id))
        .limit(limit)
        .for('update', { skipLocked: true });
      if (rows.length === 0) return [];
      // Чат має досі належати користувачу (Telegram відв'язано/перев'язано на інший акаунт —
      // повідомлення не для цього чату) → `failed 'unlinked'`, не видаємо.
      const idents = await tx
        .select({ userId: authIdentities.userId, subject: authIdentities.subject })
        .from(authIdentities)
        .where(
          and(
            eq(authIdentities.provider, 'telegram'),
            inArray(authIdentities.userId, [...new Set(rows.map((r) => r.userId))]),
          ),
        );
      const chatOf = new Map(idents.map((i) => [i.userId, i.subject]));
      const live = rows.filter((r) => chatOf.get(r.userId) === r.chatId);
      const orphaned = rows.filter((r) => chatOf.get(r.userId) !== r.chatId);
      if (orphaned.length > 0) {
        await tx
          .update(telegramOutbox)
          .set({ status: 'failed', lockedUntil: null, lastError: 'unlinked' })
          .where(
            inArray(
              telegramOutbox.id,
              orphaned.map((r) => r.id),
            ),
          );
      }
      if (live.length === 0) return [];
      await tx
        .update(telegramOutbox)
        .set({ lockedUntil, attempts: sql`${telegramOutbox.attempts} + 1` })
        .where(
          inArray(
            telegramOutbox.id,
            live.map((r) => r.id),
          ),
        );
      return live.map((r) => toItem({ ...r, attempts: r.attempts + 1 }));
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
 * Невдала спроба (саму спробу вже зараховано при видачі). `retryable` — повтор через
 * 30 с · 2^(n-1) (не раніше за `retryAfterSec`); якщо видач уже 5 — `failed`. `rateLimited`
 * (Telegram 429) — спроба не рахується (`attempts - 1`), повтор не раніше `retryAfterSec`.
 * Не `retryable` — одразу `failed`. Змінює лише `pending`-рядок (уже надісланий не
 * «псується»). `chatUnreachable` — бот заблоковано / чат не знайдено: інші очікувані й не
 * видані зараз повідомлення цього чату теж `failed` (нові, поставлені пізніше, знову
 * спробуються — користувач міг розблокувати бота).
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
    if (input.retryable && input.rateLimited) {
      const delay = Math.max(1000, (input.retryAfterSec ?? 0) * 1000);
      await tx
        .update(telegramOutbox)
        .set({
          attempts: Math.max(0, row.attempts - 1),
          nextTryAt: new Date(now.getTime() + delay),
          lockedUntil: null,
          lastError,
        })
        .where(eq(telegramOutbox.id, id));
      return;
    }
    const attempts = Math.max(1, row.attempts);
    if (input.retryable && attempts < OUTBOX_MAX_ATTEMPTS) {
      const delay = Math.max(outboxBackoffMs(attempts), (input.retryAfterSec ?? 0) * 1000);
      await tx
        .update(telegramOutbox)
        .set({ nextTryAt: new Date(now.getTime() + delay), lockedUntil: null, lastError })
        .where(eq(telegramOutbox.id, id));
      return;
    }
    await tx
      .update(telegramOutbox)
      .set({ status: 'failed', lockedUntil: null, lastError })
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

/**
 * Скасовує ще не надіслані Telegram-повідомлення користувача (`failed`, `last_error = reason`)
 * — при відв'язуванні Telegram чи видаленні акаунта, у транзакції виклику. Уже видані боту
 * рядки теж: пізній звіт `sent` лише зафіксує факт, `failed` нічого не змінить.
 */
export async function cancelPendingOutbox(
  tx: DbLike,
  userId: number,
  reason: string,
): Promise<void> {
  await tx
    .update(telegramOutbox)
    .set({ status: 'failed', lockedUntil: null, lastError: reason })
    .where(and(eq(telegramOutbox.userId, userId), eq(telegramOutbox.status, 'pending')));
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
