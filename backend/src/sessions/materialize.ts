import { and, eq, gt, gte, inArray } from 'drizzle-orm';
import { expandOccurrences, SESSION_WINDOW_DAYS } from '@nri/shared';
import type { Db } from '../db/client.js';
import { games, gameSessions, notes } from '../db/schema/index.js';
import type { Tx } from '../applications/applications.rules.js';
import { logEvent } from '../events/events.service.js';
import { AppError } from '../http/errors.js';

type GameRow = typeof games.$inferSelect;
type Exec = Db | Tx;

const DAY_MS = 86_400_000;

/** Сесії матеріалізуються лише для ігор, що набирають або йдуть. */
const isRunning = (g: Pick<GameRow, 'status'>): boolean =>
  g.status === 'recruiting' || g.status === 'started';

function isDeadlock(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const o = e as { code?: string; errno?: number };
    if (o.code === 'ER_LOCK_DEADLOCK' || o.errno === 1213) return true;
  }
  return false;
}

/**
 * Створює відсутні сесії правила (`origin='rule'`) для слотів у `[from, now + вікно)`.
 * Ідемпотентно за `UNIQUE(game_id, rule_starts_at)`: перенесена, скасована чи завершена
 * сесія зберігає свій `rule_starts_at`, тож її слот не створюється заново. Викликати під
 * блокуванням рядка гри (S чи X), щоб правило не змінилось між читанням і вставкою.
 */
export async function materializeForRow(
  exec: Exec,
  game: GameRow,
  now: Date,
  from: Date = new Date(now.getTime() - DAY_MS),
): Promise<number> {
  if (!isRunning(game)) return 0;
  // Єдина сесія ваншота (`none`) створюється одразу, навіть за межами вікна.
  const to = new Date(
    Math.max(
      now.getTime() + SESSION_WINDOW_DAYS * DAY_MS,
      game.recurrence === 'none' ? game.startsAt.getTime() + 60_000 : 0,
    ),
  );
  const slots = expandOccurrences(
    {
      startsAt: game.startsAt.toISOString(),
      durationMinutes: game.durationMinutes,
      recurrence: game.recurrence,
      weekdays: game.weekdays,
      timezone: game.timezone,
    },
    from,
    to,
  );
  if (slots.length === 0) return 0;
  // Спершу — які слоти вже є (зазвичай усі): без вставки немає й блокувань індексу.
  const existing = await exec
    .select({ at: gameSessions.ruleStartsAt })
    .from(gameSessions)
    .where(
      and(
        eq(gameSessions.gameId, game.id),
        inArray(
          gameSessions.ruleStartsAt,
          slots.map((s) => s.start),
        ),
      ),
    );
  const have = new Set(existing.map((e) => e.at?.getTime()));
  const missing = slots.filter((s) => !have.has(s.start.getTime()));
  if (missing.length === 0) return 0;
  // IGNORE: паралельна матеріалізація могла вже вставити той самий слот.
  const [res] = await exec
    .insert(gameSessions)
    .ignore()
    .values(
      missing.map((s) => ({
        gameId: game.id,
        startsAt: s.start,
        durationMinutes: game.durationMinutes,
        origin: 'rule' as const,
        ruleStartsAt: s.start,
      })),
    );
  return res.affectedRows;
}

/**
 * Зсуває вікно сесій гри до `now` (старт гри, завершення сесії, перегляд списку).
 * Рядок гри — під спільним блокуванням: зміна правила (X) не перетнеться з матеріалізацією
 * за старим правилом.
 */
export async function materializeSessions(
  deps: { db: Db },
  gameId: number,
  now: Date = new Date(),
): Promise<number> {
  const run = () =>
    deps.db.transaction(async (tx) => {
      const [g] = await tx.select().from(games).where(eq(games.id, gameId)).for('share');
      return g ? materializeForRow(tx, g, now) : 0;
    });
  try {
    return await run();
  } catch (err) {
    // Дві одночасні вставки того самого слоту можуть зустрітись на блокуваннях індексу.
    if (!isDeadlock(err)) throw err;
    return run();
  }
}

/** Причина автоскасування сесії з нотатками, яку замінило нове правило розкладу. */
export const RULE_CHANGED_REASON = 'rule_changed';

/**
 * Прибирає сесії, які замінює нове правило. Сесії з нотатками (`notes.session_id` — CASCADE)
 * не видаляються, а скасовуються (`rule_changed`; уже скасовані зберігають свою причину) і
 * звільняють слот: `rule_starts_at = NULL` (NULL у UNIQUE не конфліктує), тож нове правило
 * може згенерувати той самий слот, а повторна матеріалізація їх не «впізнає». Решта —
 * видаляються. Повертає щойно скасовані (для подій `session.cancelled`).
 */
async function dropReplacedSessions(
  tx: Tx,
  where: ReturnType<typeof and>,
): Promise<CancelledSession[]> {
  const victims = await tx
    .select({ id: gameSessions.id, gameId: gameSessions.gameId, status: gameSessions.status })
    .from(gameSessions)
    .where(where)
    .for('update');
  if (victims.length === 0) return [];
  // Блокуюче читання: бачимо нотатки, закомічені після початку транзакції.
  const noted = await tx
    .selectDistinct({ id: notes.sessionId })
    .from(notes)
    .where(
      inArray(
        notes.sessionId,
        victims.map((v) => v.id),
      ),
    )
    .for('share');
  const keep = new Set(noted.map((n) => n.id));
  const kept = victims.filter((v) => keep.has(v.id));
  const gone = victims.filter((v) => !keep.has(v.id)).map((v) => v.id);
  if (gone.length) await tx.delete(gameSessions).where(inArray(gameSessions.id, gone));
  const toCancel = kept.filter((v) => v.status === 'scheduled');
  const alreadyCancelled = kept.filter((v) => v.status !== 'scheduled').map((v) => v.id);
  if (toCancel.length) {
    await tx
      .update(gameSessions)
      .set({ status: 'cancelled', cancelReason: RULE_CHANGED_REASON, ruleStartsAt: null })
      .where(
        inArray(
          gameSessions.id,
          toCancel.map((v) => v.id),
        ),
      );
  }
  if (alreadyCancelled.length) {
    await tx
      .update(gameSessions)
      .set({ ruleStartsAt: null })
      .where(inArray(gameSessions.id, alreadyCancelled));
  }
  return toCancel.map((v) => ({ id: v.id, gameId: v.gameId }));
}

/**
 * Нове правило розкладу (викликати в транзакції, що вже змінила рядок гри, тобто тримає
 * його X-блокування): прибирає майбутні сесії правила, які ще не чіпали (`scheduled`,
 * `origin='rule'`, не перенесені), і матеріалізує нові від `now`. Перенесені, скасовані,
 * завершені й ручні сесії лишаються. Сесії з нотатками не видаляються, а скасовуються
 * (`rule_changed`) — див. `dropReplacedSessions`.
 *
 * Ваншот має одну дійсну сесію: новий час замінює її `scheduled`- чи `cancelled`-сесію
 * (навіть перенесену чи минулу), а якщо сесію вже завершено — 409 `SESSION_INVALID_STATE`.
 */
export async function replaceRuleSessions(
  tx: Tx,
  game: GameRow,
  now: Date,
): Promise<CancelledSession[]> {
  if (game.kind === 'oneshot') {
    const [done] = await tx
      .select({ id: gameSessions.id })
      .from(gameSessions)
      .where(and(eq(gameSessions.gameId, game.id), eq(gameSessions.status, 'done')))
      .limit(1);
    if (done) throw new AppError(409, 'SESSION_INVALID_STATE');
    // Скасовані теж: інакше скасована сесія зі старим `rule_starts_at` блокувала б (UNIQUE)
    // нову, якщо час повернули рівно на той самий слот, — і гра лишилась би без сесії.
    const cancelled = await dropReplacedSessions(
      tx,
      and(
        eq(gameSessions.gameId, game.id),
        inArray(gameSessions.status, ['scheduled', 'cancelled']),
      ),
    );
    await materializeForRow(tx, game, now, game.startsAt);
    return cancelled;
  }
  const cancelled = await dropReplacedSessions(
    tx,
    and(
      eq(gameSessions.gameId, game.id),
      eq(gameSessions.status, 'scheduled'),
      eq(gameSessions.origin, 'rule'),
      eq(gameSessions.rescheduled, false),
      gt(gameSessions.startsAt, now),
    ),
  );
  await materializeForRow(tx, game, now, now);
  return cancelled;
}

/** Скасована сесія — для подій `session.cancelled` після коміту. */
export interface CancelledSession {
  id: number;
  gameId: number;
}

/**
 * Завершення чи скасування гри (викликати в транзакції, що тримає X-блокування гри):
 * майбутні `scheduled` сесії → `cancelled` з причиною `game_finished`/`game_cancelled`.
 * Минулі `scheduled` лишаються як є (історія; завершити їх уже не можна).
 */
export async function cancelFutureSessions(
  tx: Tx,
  gameIds: number[],
  now: Date,
  reason: 'game_finished' | 'game_cancelled',
): Promise<CancelledSession[]> {
  if (gameIds.length === 0) return [];
  const rows = await tx
    .select({ id: gameSessions.id, gameId: gameSessions.gameId })
    .from(gameSessions)
    .where(
      and(
        inArray(gameSessions.gameId, gameIds),
        eq(gameSessions.status, 'scheduled'),
        gt(gameSessions.startsAt, now),
      ),
    )
    .for('update');
  if (rows.length === 0) return [];
  await tx
    .update(gameSessions)
    .set({ status: 'cancelled', cancelReason: reason })
    .where(
      and(
        inArray(
          gameSessions.id,
          rows.map((r) => r.id),
        ),
        eq(gameSessions.status, 'scheduled'),
      ),
    );
  return rows;
}

/** Події `session.cancelled` для автоскасованих сесій (після коміту). */
export async function logSessionsCancelled(
  db: Db,
  /** `null` — без автора (гру закрила адміністрація). */
  userId: number | null,
  rows: CancelledSession[],
  reason: 'game_finished' | 'game_cancelled' | typeof RULE_CHANGED_REASON,
): Promise<void> {
  for (const r of rows) {
    await logEvent(db, {
      type: 'session.cancelled',
      userId,
      entityType: 'session',
      entityId: r.id,
      // auto: скасовано разом із грою/правилом — окремого сповіщення немає (є про гру).
      payload: { gameId: r.gameId, reason, auto: true },
    });
  }
}

/** Сесії гри для списку: минулі `pastDays` діб і всі майбутні (з перенесеними). */
export function sessionsWindow(gameId: number, now: Date, pastDays = 30) {
  return and(
    eq(gameSessions.gameId, gameId),
    gte(gameSessions.startsAt, new Date(now.getTime() - pastDays * DAY_MS)),
  );
}
