import { and, eq, exists, gte, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import {
  FINAL_RATING_WINDOW_DAYS,
  SESSION_RATING_WINDOW_DAYS,
  type RatingRole,
  type RatingTargetDto,
  type RatingTargetState,
  type RatingTargetsDto,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { Db } from '../db/client.js';
import type { Tx } from '../applications/applications.rules.js';
import {
  gameMembers,
  games,
  gameSessions,
  ratings,
  sessionAttendance,
  users,
} from '../db/schema/index.js';
import { isHiddenFromNonGm } from '../games/games.visibility.js';
import { AppError } from '../http/errors.js';

/** Запити поза транзакцією або в ній (перевірка цілі при збереженні оцінки). */
export type Q = Db | Tx;

const DAY_MS = 86_400_000;
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);
/** Вікно, що вже закрите (`finished`/`cancelled` без мітки часу — узгоджено з `pendingRatings`). */
const CLOSED = new Date(0);

export type RatingGame = Pick<
  typeof games.$inferSelect,
  'id' | 'gmUserId' | 'kind' | 'status' | 'publishedAt' | 'finishedAt' | 'cancelledAt'
>;

const GAME_COLS = {
  id: games.id,
  gmUserId: games.gmUserId,
  kind: games.kind,
  status: games.status,
  publishedAt: games.publishedAt,
  finishedAt: games.finishedAt,
  cancelledAt: games.cancelledAt,
};

/** Факти гри, з яких виводяться права й вікна. */
interface GameFacts {
  game: RatingGame;
  /** Проведені (`done`) сесії: id → момент завершення. */
  doneAt: Map<number, Date>;
  /** Присутні на кожній `done` сесії; майстер гри — на всіх. */
  present: Map<number, Set<number>>;
  /** Усі виходи (виключення, бани) кожного, хто колись виходив (з повернення — кілька). */
  leftAt: Map<number, Date[]>;
}

/**
 * Один набір кандидатів (без урахування вікна): `sessionId` — сесійна оцінка, `null` —
 * підсумкова/«вихідна». `closesAt` `null` — «вихідна», поки гра йде (дедлайну немає).
 */
export interface CandidateSet {
  gameId: number;
  sessionId: number | null;
  closesAt: Date | null;
  rateeIds: number[];
}

export const isWindowOpen = (closesAt: Date | null, now: Date): boolean =>
  closesAt === null || now.getTime() <= closesAt.getTime();

/** Роль/джерело оцінки за грою. */
export function ratingRole(gmUserId: number, raterId: number, rateeId: number): RatingRole {
  if (rateeId === gmUserId) return 'gm';
  return raterId === gmUserId ? 'player_from_gm' : 'player_from_player';
}

export async function loadRatingGame(q: Q, gameId: number): Promise<RatingGame | undefined> {
  const [g] = await q.select(GAME_COLS).from(games).where(eq(games.id, gameId));
  return g;
}

/**
 * Пакетне завантаження фактів для набору ігор (3 запити незалежно від кількості ігор).
 * Ваншот, завершений кнопкою «Завершити гру», має `done`-сесію без жодного рядка
 * присутності — тоді присутніми вважаються всі, хто був учасником на момент завершення сесії.
 */
async function loadFacts(q: Q, list: RatingGame[]): Promise<Map<number, GameFacts>> {
  const out = new Map<number, GameFacts>();
  if (list.length === 0) return out;
  for (const game of list) {
    out.set(game.id, { game, doneAt: new Map(), present: new Map(), leftAt: new Map() });
  }
  const ids = list.map((g) => g.id);
  const [sessions, members] = await Promise.all([
    q
      .select({
        id: gameSessions.id,
        gameId: gameSessions.gameId,
        doneAt: gameSessions.doneAt,
        startsAt: gameSessions.startsAt,
      })
      .from(gameSessions)
      .where(and(inArray(gameSessions.gameId, ids), eq(gameSessions.status, 'done'))),
    q
      .select({
        gameId: gameMembers.gameId,
        userId: gameMembers.userId,
        joinedAt: gameMembers.joinedAt,
        leftAt: gameMembers.leftAt,
      })
      .from(gameMembers)
      .where(inArray(gameMembers.gameId, ids)),
  ]);
  const attendance = sessions.length
    ? await q
        .select({
          sessionId: sessionAttendance.sessionId,
          userId: sessionAttendance.userId,
          present: sessionAttendance.present,
        })
        .from(sessionAttendance)
        .where(
          inArray(
            sessionAttendance.sessionId,
            sessions.map((s) => s.id),
          ),
        )
    : [];

  for (const m of members) {
    if (!m.leftAt) continue;
    const f = out.get(m.gameId)!;
    const list = f.leftAt.get(m.userId);
    if (list) list.push(m.leftAt);
    else f.leftAt.set(m.userId, [m.leftAt]);
  }
  const recorded = new Set<number>();
  const sessionGame = new Map<number, number>();
  for (const s of sessions) {
    const f = out.get(s.gameId)!;
    const doneAt = s.doneAt ?? s.startsAt;
    f.doneAt.set(s.id, doneAt);
    f.present.set(s.id, new Set([f.game.gmUserId]));
    sessionGame.set(s.id, s.gameId);
  }
  for (const a of attendance) {
    recorded.add(a.sessionId);
    if (a.present) out.get(sessionGame.get(a.sessionId)!)!.present.get(a.sessionId)!.add(a.userId);
  }
  for (const s of sessions) {
    const f = out.get(s.gameId)!;
    if (f.game.kind !== 'oneshot' || recorded.has(s.id)) continue;
    const doneAt = f.doneAt.get(s.id)!;
    const set = f.present.get(s.id)!;
    for (const m of members) {
      if (m.gameId === s.gameId && m.joinedAt <= doneAt && (!m.leftAt || m.leftAt > doneAt)) {
        set.add(m.userId);
      }
    }
  }
  return out;
}

const together = (f: GameFacts, a: number, b: number): boolean => {
  if (a === b) return false;
  for (const set of f.present.values()) if (set.has(a) && set.has(b)) return true;
  return false;
};

/**
 * «Вихідна» пара: хтось із двох вийшов (`L <= now`) ПІСЛЯ спільної `done` сесії
 * (`doneAt <= L`). Так той, хто повернувся, і гравець, що приєднався після його виходу, не
 * стають «вихідною» парою лише через старий вихід.
 */
const leavePair = (f: GameFacts, a: number, b: number, now: Date): boolean => {
  const leaves = [...(f.leftAt.get(a) ?? []), ...(f.leftAt.get(b) ?? [])].filter((l) => l <= now);
  if (leaves.length === 0) return false;
  for (const [sessionId, set] of f.present) {
    if (!set.has(a) || !set.has(b)) continue;
    const doneAt = f.doneAt.get(sessionId)!;
    if (leaves.some((l) => doneAt <= l)) return true;
  }
  return false;
};

/**
 * Усі набори кандидатів оцінювача в грі (вікна НЕ відфільтровано — щоб відрізнити «не можна»
 * від «уже пізно»):
 * - сесійні — для кожної `done` сесії кампанії, де оцінювач присутній: інші присутні,
 *   вікно 14 днів від завершення сесії;
 * - підсумковий — усі, з ким грали разом, якщо гра `finished` (30 днів від завершення);
 *   інакше лише пари, де хтось вийшов: поки гра йде — без дедлайну, після скасування —
 *   30 днів від скасування. Чернетка — нічого.
 */
function candidateSets(f: GameFacts, raterId: number, now: Date): CandidateSet[] {
  const { game } = f;
  const sets: CandidateSet[] = [];
  if (game.kind === 'campaign') {
    for (const [sessionId, set] of f.present) {
      if (!set.has(raterId)) continue;
      sets.push({
        gameId: game.id,
        sessionId,
        closesAt: addDays(f.doneAt.get(sessionId)!, SESSION_RATING_WINDOW_DAYS),
        rateeIds: [...set].filter((u) => u !== raterId),
      });
    }
  }
  const others = new Set<number>();
  for (const set of f.present.values()) {
    if (set.has(raterId)) for (const u of set) if (u !== raterId) others.add(u);
  }
  let closesAt: Date | null;
  let needsLeave = true;
  if (game.status === 'finished') {
    closesAt = game.finishedAt ? addDays(game.finishedAt, FINAL_RATING_WINDOW_DAYS) : CLOSED;
    needsLeave = false;
  } else if (game.status === 'cancelled') {
    closesAt = game.cancelledAt ? addDays(game.cancelledAt, FINAL_RATING_WINDOW_DAYS) : CLOSED;
  } else if (game.status === 'draft') {
    return sets;
  } else {
    closesAt = null;
  }
  const rateeIds = [...others].filter((u) => !needsLeave || leavePair(f, raterId, u, now));
  sets.push({ gameId: game.id, sessionId: null, closesAt, rateeIds });
  return sets;
}

/** Обидва були хоча б на одній `done` сесії гри (майстер — на всіх). */
export async function playedTogether(q: Q, gameId: number, a: number, b: number): Promise<boolean> {
  const game = await loadRatingGame(q, gameId);
  if (!game) return false;
  const f = (await loadFacts(q, [game])).get(gameId)!;
  return together(f, a, b);
}

/** Набори кандидатів оцінювача для однієї гри (для перевірки при збереженні). */
export async function candidateSetsFor(
  q: Q,
  game: RatingGame,
  raterId: number,
  now: Date,
): Promise<CandidateSet[]> {
  const f = (await loadFacts(q, [game])).get(game.id)!;
  return candidateSets(f, raterId, now);
}

const slotOf = (sessionId: number | null) => sessionId ?? 0;

/**
 * Перетворює відкриті набори на DTO: лише активні акаунти, стан — з наявних оцінок
 * оцінювача (2 запити на всі набори). Майстер — першим, далі за ніком.
 */
async function hydrate(
  q: Q,
  raterId: number,
  sets: CandidateSet[],
  gmOf: Map<number, number>,
): Promise<RatingTargetsDto[]> {
  const userIds = [...new Set(sets.flatMap((s) => s.rateeIds))];
  const gameIds = [...new Set(sets.map((s) => s.gameId))];
  const [people, mine] = await Promise.all([
    userIds.length
      ? q
          .select({
            id: users.id,
            publicId: users.publicId,
            nickname: users.nickname,
            avatarUrl: users.avatarUrl,
          })
          .from(users)
          .where(and(inArray(users.id, userIds), eq(users.status, 'active')))
      : Promise.resolve([]),
    gameIds.length
      ? q
          .select({
            gameId: ratings.gameId,
            rateeId: ratings.rateeId,
            slotKey: ratings.slotKey,
            declined: ratings.declined,
          })
          .from(ratings)
          .where(and(eq(ratings.raterId, raterId), inArray(ratings.gameId, gameIds)))
      : Promise.resolve([]),
  ]);
  const byId = new Map(people.map((p) => [p.id, p]));
  const state = new Map<string, RatingTargetState>(
    mine.map((r) => [`${r.gameId}:${r.slotKey}:${r.rateeId}`, r.declined ? 'declined' : 'rated']),
  );
  return sets.map((s) => {
    const gm = gmOf.get(s.gameId)!;
    const targets: RatingTargetDto[] = s.rateeIds
      .filter((id) => byId.has(id))
      .sort(
        (a, b) =>
          Number(b === gm) - Number(a === gm) ||
          (byId.get(a)!.nickname ?? '').localeCompare(byId.get(b)!.nickname ?? '', 'uk'),
      )
      .map((id) => {
        const p = byId.get(id)!;
        return {
          publicId: p.publicId,
          nickname: p.nickname ?? '',
          avatarUrl: p.avatarUrl,
          role: ratingRole(gm, raterId, id),
          state: state.get(`${s.gameId}:${slotOf(s.sessionId)}:${id}`) ?? 'open',
          closesAt: s.closesAt?.toISOString() ?? null,
        };
      });
    return {
      gameId: s.gameId,
      sessionId: s.sessionId,
      kind: s.sessionId === null ? 'final' : 'session',
      targets,
    };
  });
}

/**
 * Гра для оцінювання: невідома або прихована від не-майстра → 404. Повертає гру й чи був
 * користувач колись її учасником (майстер — так).
 */
export async function accessRatingGame(
  q: Q,
  userId: number,
  gameId: number,
): Promise<{ game: RatingGame; involved: boolean }> {
  const game = await loadRatingGame(q, gameId);
  if (!game) throw new AppError(404, 'NOT_FOUND');
  if (game.gmUserId === userId) return { game, involved: true };
  if (isHiddenFromNonGm(game)) throw new AppError(404, 'NOT_FOUND');
  const [m] = await q
    .select({ id: gameMembers.id })
    .from(gameMembers)
    .where(and(eq(gameMembers.gameId, gameId), eq(gameMembers.userId, userId)))
    .limit(1);
  return { game, involved: !!m };
}

/**
 * «Кого я можу оцінити зараз» у грі: `sessionId` — сесійні цілі, `null` — підсумкові/«вихідні».
 * Закрите вікно → порожній список. Сторонній (ніколи не був учасником) → 403
 * `RATING_NOT_ALLOWED`; сесія не з цієї гри → 404.
 */
export async function ratingTargets(
  deps: Pick<AppDeps, 'db'>,
  raterId: number,
  gameId: number,
  sessionId: number | null,
  now: Date = new Date(),
): Promise<RatingTargetsDto> {
  const { db } = deps;
  const { game, involved } = await accessRatingGame(db, raterId, gameId);
  if (!involved) throw new AppError(403, 'RATING_NOT_ALLOWED');
  if (sessionId !== null) await assertSessionOfGame(db, gameId, sessionId);
  const sets = await candidateSetsFor(db, game, raterId, now);
  const set = sets.find((s) => s.sessionId === sessionId);
  const empty: RatingTargetsDto = {
    gameId,
    sessionId,
    kind: sessionId === null ? 'final' : 'session',
    targets: [],
  };
  if (!set || !isWindowOpen(set.closesAt, now)) return empty;
  const [dto] = await hydrate(db, raterId, [set], new Map([[game.id, game.gmUserId]]));
  return dto!;
}

export async function assertSessionOfGame(q: Q, gameId: number, sessionId: number) {
  const [s] = await q
    .select({ id: gameSessions.id })
    .from(gameSessions)
    .where(and(eq(gameSessions.id, sessionId), eq(gameSessions.gameId, gameId)));
  if (!s) throw new AppError(404, 'NOT_FOUND');
}

/**
 * Усі набори з хоча б однією відкритою ціллю для користувача (сторінка «Оцінити»).
 * Обмежена кількість запитів: ігри-кандидати (з відкритим за часом вікном або з виходом
 * когось у грі, що йде) + пакетні факти + пакетна гідратація. Порядок: найближчий дедлайн
 * першим, без дедлайну — у кінці.
 */
export async function pendingRatings(
  deps: Pick<AppDeps, 'db'>,
  userId: number,
  now: Date = new Date(),
): Promise<RatingTargetsDto[]> {
  const { db } = deps;
  const [own, joined] = await Promise.all([
    db.select({ id: games.id }).from(games).where(eq(games.gmUserId, userId)),
    db
      .selectDistinct({ id: gameMembers.gameId })
      .from(gameMembers)
      .where(eq(gameMembers.userId, userId)),
  ]);
  const ids = [...new Set([...own, ...joined].map((r) => r.id))];
  if (ids.length === 0) return [];
  const finalSince = addDays(now, -FINAL_RATING_WINDOW_DAYS);
  const sessionSince = addDays(now, -SESSION_RATING_WINDOW_DAYS);
  const someoneLeft = db
    .select({ x: sql`1` })
    .from(gameMembers)
    .where(and(eq(gameMembers.gameId, games.id), isNotNull(gameMembers.leftAt)));
  const recentDone = db
    .select({ x: sql`1` })
    .from(gameSessions)
    .where(
      and(
        eq(gameSessions.gameId, games.id),
        eq(gameSessions.status, 'done'),
        gte(gameSessions.doneAt, sessionSince),
      ),
    );
  const list = await db
    .select(GAME_COLS)
    .from(games)
    .where(
      and(
        inArray(games.id, ids),
        ne(games.status, 'draft'),
        isNotNull(games.publishedAt),
        or(
          and(inArray(games.status, ['recruiting', 'started']), exists(someoneLeft)),
          and(eq(games.status, 'finished'), gte(games.finishedAt, finalSince)),
          and(eq(games.status, 'cancelled'), gte(games.cancelledAt, finalSince)),
          exists(recentDone),
        ),
      ),
    );
  const facts = await loadFacts(db, list);
  const open: CandidateSet[] = [];
  for (const f of facts.values()) {
    for (const s of candidateSets(f, userId, now)) {
      if (s.rateeIds.length && isWindowOpen(s.closesAt, now)) open.push(s);
    }
  }
  const gmOf = new Map(list.map((g) => [g.id, g.gmUserId]));
  const dtos = await hydrate(db, userId, open, gmOf);
  const closes = new Map(open.map((s, i) => [dtos[i]!, s.closesAt?.getTime() ?? null]));
  const byDeadline = (a: number | null, b: number | null) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b;
  return dtos
    .filter((d) => d.targets.some((t) => t.state === 'open'))
    .sort(
      (a, b) =>
        byDeadline(closes.get(a) ?? null, closes.get(b) ?? null) ||
        a.gameId - b.gameId ||
        (a.sessionId ?? 0) - (b.sessionId ?? 0),
    );
}
