import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, lte } from 'drizzle-orm';
import { DEFAULT_REMINDER_OFFSETS, REMINDER_OFFSETS } from '@nri/shared';
import type { AppDeps } from '../app.js';
import { isDuplicateKey, isTransientDbError } from '../db/errors.js';
import {
  gameMembers,
  games,
  gameSessions,
  notificationPrefs,
  reminderLog,
  users,
} from '../db/schema/index.js';
import {
  createNotification,
  emitNotificationsNew,
  type NotificationRow,
} from './notifications.service.js';

export const REMINDERS_JOB = 'notifications.reminders';
export const REMINDERS_EVERY_MS = 5 * 60_000;
/**
 * Запас на запізнілий/повторений запуск: момент нагадування може бути до 15 хв у минулому.
 * Старіші пропущені нагадування не «доганяються» (P4-13).
 */
export const REMINDER_GRACE_MS = 15 * 60_000;

const MIN = 60_000;
const RUNNING_GAME_STATUSES = ['recruiting', 'started'] as const;
const RUNNING = new Set<string>(RUNNING_GAME_STATUSES);

type SessionCandidate = {
  id: number;
  gameId: number;
  gameTitle: string;
  gmUserId: number;
  startsAt: Date;
  startWindowMinutes: number | null;
};

type Planned = { session: SessionCandidate; userId: number; offsetMin: number };

/**
 * Нагадування перед сесіями для вікна задачі, що запланована на `runAt`: офсет `o`
 * (для сесії з приблизним часом — від початку вікна `starts_at`)
 * спрацьовує, якщо момент `starts_at − o` ∈ [max(runAt, now) − запас, runAt + 5 хв), а сесія ще
 * не почалась (`starts_at > now`). Лише `scheduled` сесії опублікованих ігор, що набирають або
 * йдуть. Отримувачі — майстер і активні учасники (`left_at IS NULL`, акаунт активний, не
 * забанений), у чиїх `reminderOffsets` є цей офсет (без рядка prefs — за замовчуванням).
 *
 * Дедуплікація — `reminder_log` UNIQUE(session, user, offset, starts_at): повторний чи
 * паралельний прогін нічого не дублює, а перенесена сесія отримує нагадування за новим часом.
 * Кожна сесія — окрема транзакція (рядок сесії під S-блокуванням і перевіркою, що вона досі
 * `scheduled` з тим самим часом). Пінги `notification.new` — після коміту.
 * Тимчасова помилка БД прокидається (задача повторить; надіслане не дублюється); інша
 * помилка однієї сесії логується, решта сесій обробляються, задача завершується успішно.
 */
export async function sendReminders(
  deps: AppDeps,
  runAt: Date,
  now: Date = new Date(),
): Promise<NotificationRow[]> {
  // Напіввідкрите вікно [from, to): сусідні слоти не перетинаються на межі. Нижня межа
  // прив'язана й до реального часу: задача, що прокинулась через години після свого слоту,
  // не «доганяє» нагадування старші за запас (P4-13).
  const windowFrom = Math.max(runAt.getTime(), now.getTime()) - REMINDER_GRACE_MS;
  const windowTo = runAt.getTime() + REMINDERS_EVERY_MS;
  if (windowFrom >= windowTo) return [];
  const offsets = [...REMINDER_OFFSETS];
  const minOff = Math.min(...offsets) * MIN;
  const maxOff = Math.max(...offsets) * MIN;

  const sessions: SessionCandidate[] = await deps.db
    .select({
      id: gameSessions.id,
      gameId: gameSessions.gameId,
      gameTitle: games.title,
      gmUserId: games.gmUserId,
      startsAt: gameSessions.startsAt,
      startWindowMinutes: gameSessions.startWindowMinutes,
    })
    .from(gameSessions)
    .innerJoin(games, eq(games.id, gameSessions.gameId))
    .where(
      and(
        eq(gameSessions.status, 'scheduled'),
        gt(gameSessions.startsAt, now),
        gte(gameSessions.startsAt, new Date(windowFrom + minOff)),
        lt(gameSessions.startsAt, new Date(windowTo + maxOff)),
        inArray(games.status, [...RUNNING_GAME_STATUSES]),
        isNotNull(games.publishedAt),
      ),
    );

  const due = sessions.flatMap((s) => {
    const start = s.startsAt.getTime();
    if (start <= now.getTime()) return [];
    const hit = offsets.filter((o) => {
      const moment = start - o * MIN;
      return moment >= windowFrom && moment < windowTo;
    });
    return hit.length ? [{ session: s, offsets: hit }] : [];
  });
  if (due.length === 0) return [];

  const gameIds = [...new Set(due.map((d) => d.session.gameId))];
  const memberRows = await deps.db
    .select({ gameId: gameMembers.gameId, userId: gameMembers.userId })
    .from(gameMembers)
    .where(and(inArray(gameMembers.gameId, gameIds), isNull(gameMembers.leftAt)));
  const membersByGame = new Map<number, number[]>();
  for (const r of memberRows) {
    const list = membersByGame.get(r.gameId) ?? [];
    list.push(r.userId);
    membersByGame.set(r.gameId, list);
  }

  const userIds = new Set<number>();
  for (const d of due) {
    userIds.add(d.session.gmUserId);
    for (const u of membersByGame.get(d.session.gameId) ?? []) userIds.add(u);
  }
  const userRows = await deps.db
    .select({ id: users.id, offsets: notificationPrefs.reminderOffsets })
    .from(users)
    .leftJoin(notificationPrefs, eq(notificationPrefs.userId, users.id))
    .where(
      and(inArray(users.id, [...userIds]), eq(users.status, 'active'), eq(users.isBanned, false)),
    );
  const offsetsOf = new Map<number, Set<number>>(
    userRows.map((u) => [u.id, new Set<number>(u.offsets ?? DEFAULT_REMINDER_OFFSETS)]),
  );

  const bySession = new Map<number, Planned[]>();
  for (const { session, offsets: hit } of due) {
    const recipients = new Set([session.gmUserId, ...(membersByGame.get(session.gameId) ?? [])]);
    for (const userId of recipients) {
      const wanted = offsetsOf.get(userId);
      if (!wanted) continue;
      for (const offsetMin of hit) {
        if (!wanted.has(offsetMin)) continue;
        const list = bySession.get(session.id) ?? [];
        list.push({ session, userId, offsetMin });
        bySession.set(session.id, list);
      }
    }
  }

  const created: NotificationRow[] = [];
  for (const planned of bySession.values()) {
    // Сталий порядок вставок у reminder_log: паралельні прогони не блокують одне одного по колу.
    planned.sort((a, b) => a.userId - b.userId || a.offsetMin - b.offsetMin);
    try {
      const rows = await remindSession(deps, planned);
      emitNotificationsNew(deps, rows);
      created.push(...rows);
    } catch (err) {
      if (isTransientDbError(err)) throw err;
      // Нетимчасова помилка однієї сесії не валить задачу (повтор її не виправить).
      console.error(`reminders: session ${planned[0]!.session.id} failed`, err);
    }
  }
  return created;
}

async function remindSession(deps: AppDeps, planned: Planned[]): Promise<NotificationRow[]> {
  const { session } = planned[0]!;
  return deps.db.transaction(async (tx) => {
    // Скасування/перенесення бере X-блокування рядка: після нього сесію вже не впізнаємо.
    // Членство й статус гри тут свідомо не перевіряються повторно: вихід/виключення чи
    // завершення гри в ці мілісекунди дасть щонайбільше одне зайве нагадування (прийнято;
    // завершення/скасування гри й так скасовує майбутні сесії під X-блокуванням).
    // Порядок блокувань як у RSVP/затвердженні: гра (FOR SHARE) → сесія.
    await tx.select({ id: games.id }).from(games).where(eq(games.id, session.gameId)).for('share');
    const [still] = await tx
      .select({ id: gameSessions.id })
      .from(gameSessions)
      .where(
        and(
          eq(gameSessions.id, session.id),
          eq(gameSessions.status, 'scheduled'),
          eq(gameSessions.startsAt, session.startsAt),
        ),
      )
      .for('share');
    if (!still) return [];
    const rows: NotificationRow[] = [];
    for (const p of planned) {
      try {
        await tx.insert(reminderLog).values({
          sessionId: session.id,
          userId: p.userId,
          offsetMin: p.offsetMin,
          startsAt: session.startsAt,
        });
      } catch (err) {
        // Уже надіслано (цей чи паралельний прогін). У MySQL дубль відкочує лише оператор.
        if (isDuplicateKey(err)) continue;
        throw err;
      }
      rows.push(
        await createNotification(deps, tx, {
          userId: p.userId,
          type: 'session.reminder',
          category: 'reminders',
          params: {
            gameId: session.gameId,
            gameTitle: session.gameTitle,
            sessionId: session.id,
            startsAt: session.startsAt.toISOString(),
            offsetMin: p.offsetMin,
            // Приблизний час: нагадування рахується від початку вікна, текст — з вікном.
            ...(session.startWindowMinutes !== null
              ? { startWindowMinutes: session.startWindowMinutes }
              : {}),
          },
          entityType: 'session',
          entityId: session.id,
        }),
      );
    }
    return rows;
  });
}

// ---------- приблизний час: нагадування майстру уточнити ----------

/** За скільки до початку вікна майстру нагадують уточнити час сесії. */
export const UNPINNED_REMINDER_BEFORE_MS = 24 * 60 * MIN;

/**
 * Майстру — `session.time_unpinned` (категорія `sessions`, не термінове — у тихі години чекає
 * ранку): сесія з приблизним часом (`start_window_minutes IS NOT NULL`) починається не далі ніж
 * за 24 год (від `now` до `starts_at`, тобто початку вікна), а майстер ще не уточнив час. Один раз
 * на час сесії: штамп `unpinned_reminded_at` ставиться в тій самій транзакції (перенесення його
 * скидає — нове вікно отримає своє нагадування). Сесія, якій вікно задали менш ніж за добу, —
 * нагадування на найближчому прогоні. Лише `scheduled` сесії опублікованих ігор, що набирають
 * чи йдуть, і лише активному незаблокованому майстру. Пінги — після коміту.
 */
export async function sendUnpinnedReminders(
  deps: AppDeps,
  now: Date = new Date(),
): Promise<NotificationRow[]> {
  const due = await deps.db
    .select({ id: gameSessions.id })
    .from(gameSessions)
    .innerJoin(games, eq(games.id, gameSessions.gameId))
    .innerJoin(users, eq(users.id, games.gmUserId))
    .where(
      and(
        eq(gameSessions.status, 'scheduled'),
        isNotNull(gameSessions.startWindowMinutes),
        isNull(gameSessions.unpinnedRemindedAt),
        gt(gameSessions.startsAt, now),
        lte(gameSessions.startsAt, new Date(now.getTime() + UNPINNED_REMINDER_BEFORE_MS)),
        inArray(games.status, [...RUNNING_GAME_STATUSES]),
        isNotNull(games.publishedAt),
        eq(users.status, 'active'),
        eq(users.isBanned, false),
      ),
    )
    .orderBy(gameSessions.id);
  const created: NotificationRow[] = [];
  for (const { id } of due) {
    try {
      const row = await remindUnpinned(deps, id, now);
      if (row) {
        emitNotificationsNew(deps, [row]);
        created.push(row);
      }
    } catch (err) {
      if (isTransientDbError(err)) throw err;
      console.error(`reminders: unpinned session ${id} failed`, err);
    }
  }
  return created;
}

async function remindUnpinned(
  deps: AppDeps,
  sessionId: number,
  now: Date,
): Promise<NotificationRow | null> {
  return deps.db.transaction(async (tx) => {
    const [ref] = await tx
      .select({ gameId: gameSessions.gameId })
      .from(gameSessions)
      .where(eq(gameSessions.id, sessionId));
    if (!ref) return null;
    // Порядок блокувань як у діях майстра: гра (FOR SHARE) → сесія (FOR UPDATE). Під
    // блокуванням — ті самі умови, що й у вибірці (гра йде, майстер активний).
    const [r] = await tx
      .select({
        gameId: games.id,
        title: games.title,
        gmUserId: games.gmUserId,
        status: games.status,
        publishedAt: games.publishedAt,
      })
      .from(games)
      .where(eq(games.id, ref.gameId))
      .for('share');
    if (!r || !RUNNING.has(r.status) || r.publishedAt === null) return null;
    const [gm] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, r.gmUserId), eq(users.status, 'active'), eq(users.isBanned, false)));
    if (!gm) return null;
    const [s] = await tx
      .select()
      .from(gameSessions)
      .where(
        and(
          eq(gameSessions.id, sessionId),
          eq(gameSessions.status, 'scheduled'),
          isNotNull(gameSessions.startWindowMinutes),
          isNull(gameSessions.unpinnedRemindedAt),
          gt(gameSessions.startsAt, now),
          lte(gameSessions.startsAt, new Date(now.getTime() + UNPINNED_REMINDER_BEFORE_MS)),
        ),
      )
      .for('update');
    if (!s) return null;
    await tx
      .update(gameSessions)
      .set({ unpinnedRemindedAt: now })
      .where(eq(gameSessions.id, sessionId));
    return createNotification(deps, tx, {
      userId: r.gmUserId,
      type: 'session.time_unpinned',
      category: 'sessions',
      params: {
        gameId: r.gameId,
        gameTitle: r.title,
        sessionId,
        startsAt: s.startsAt.toISOString(),
        startWindowMinutes: s.startWindowMinutes,
      },
      entityType: 'session',
      entityId: sessionId,
    });
  });
}
