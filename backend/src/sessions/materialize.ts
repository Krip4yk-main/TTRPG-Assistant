import { and, eq, gt, gte, inArray } from 'drizzle-orm';
import { expandOccurrences, SESSION_WINDOW_DAYS } from '@nri/shared';
import type { Db } from '../db/client.js';
import { games, gameSessions } from '../db/schema/index.js';
import type { Tx } from '../applications/applications.rules.js';

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
  const to = new Date(now.getTime() + SESSION_WINDOW_DAYS * DAY_MS);
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

/**
 * Нове правило розкладу (викликати в транзакції, що вже змінила рядок гри, тобто тримає
 * його X-блокування): видаляє майбутні сесії правила, які ще не чіпали (`scheduled`,
 * `origin='rule'`, не перенесені), і матеріалізує нові від `now`. Перенесені, скасовані,
 * завершені й ручні сесії лишаються.
 */
export async function replaceRuleSessions(tx: Tx, game: GameRow, now: Date): Promise<void> {
  await tx
    .delete(gameSessions)
    .where(
      and(
        eq(gameSessions.gameId, game.id),
        eq(gameSessions.status, 'scheduled'),
        eq(gameSessions.origin, 'rule'),
        eq(gameSessions.rescheduled, false),
        gt(gameSessions.startsAt, now),
      ),
    );
  await materializeForRow(tx, game, now, now);
}

/** Сесії гри для списку: минулі `pastDays` діб і всі майбутні (з перенесеними). */
export function sessionsWindow(gameId: number, now: Date, pastDays = 30) {
  return and(
    eq(gameSessions.gameId, gameId),
    gte(gameSessions.startsAt, new Date(now.getTime() - pastDays * DAY_MS)),
  );
}
