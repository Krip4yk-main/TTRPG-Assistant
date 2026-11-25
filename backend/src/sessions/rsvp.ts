import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  rsvpInputSchema,
  type RsvpStatus,
  type SessionDto,
  type SessionRsvpSummary,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import { gameMembers, games, gameSessions, sessionRsvp, users } from '../db/schema/index.js';
import { isHiddenFromNonGm } from '../games/games.visibility.js';
import { AppError } from '../http/errors.js';

export type RsvpView = Pick<SessionDto, 'myRsvp' | 'rsvpSummary'>;

const NO_RSVP: RsvpView = { myRsvp: null, rsvpSummary: null };

/**
 * RSVP-частина `SessionDto` для глядача: учасник бачить лише свою відповідь, майстер — лише
 * зведення по активних учасниках (`status: null` — не відповів; відповіді колишніх учасників
 * не враховуються). Іншим нічого (приватність учасників).
 */
export async function rsvpViews(
  deps: Pick<AppDeps, 'db'>,
  viewerId: number,
  game: { id: number; gmUserId: number },
  sessionIds: number[],
): Promise<Map<number, RsvpView>> {
  const out = new Map<number, RsvpView>();
  if (sessionIds.length === 0) return out;
  const { db } = deps;
  if (game.gmUserId !== viewerId) {
    const mine = await db
      .select({ sessionId: sessionRsvp.sessionId, status: sessionRsvp.status })
      .from(sessionRsvp)
      .where(and(eq(sessionRsvp.userId, viewerId), inArray(sessionRsvp.sessionId, sessionIds)));
    const byId = new Map(mine.map((r) => [r.sessionId, r.status]));
    for (const id of sessionIds) out.set(id, { myRsvp: byId.get(id) ?? null, rsvpSummary: null });
    return out;
  }
  const members = await db
    .select({ userId: gameMembers.userId, publicId: users.publicId, nickname: users.nickname })
    .from(gameMembers)
    .innerJoin(users, eq(users.id, gameMembers.userId))
    .where(and(eq(gameMembers.gameId, game.id), isNull(gameMembers.leftAt)))
    .orderBy(asc(gameMembers.joinedAt), asc(gameMembers.id));
  const answers = members.length
    ? await db
        .select({
          sessionId: sessionRsvp.sessionId,
          userId: sessionRsvp.userId,
          status: sessionRsvp.status,
        })
        .from(sessionRsvp)
        .where(
          and(
            inArray(sessionRsvp.sessionId, sessionIds),
            inArray(
              sessionRsvp.userId,
              members.map((m) => m.userId),
            ),
          ),
        )
    : [];
  const key = (s: number, u: number): string => `${s}:${u}`;
  const statusOf = new Map(answers.map((a) => [key(a.sessionId, a.userId), a.status]));
  for (const id of sessionIds) {
    const summary: SessionRsvpSummary = { going: 0, notGoing: 0, members: [] };
    for (const m of members) {
      const status = statusOf.get(key(id, m.userId)) ?? null;
      if (status === 'going') summary.going += 1;
      if (status === 'not_going') summary.notGoing += 1;
      summary.members.push({ publicId: m.publicId, nickname: m.nickname ?? '', status });
    }
    out.set(id, { myRsvp: null, rsvpSummary: summary });
  }
  return out;
}

export const rsvpOf = (views: Map<number, RsvpView>, sessionId: number): RsvpView =>
  views.get(sessionId) ?? NO_RSVP;

/**
 * RSVP «буду / не зможу» на майбутню `scheduled` сесію гри, що набирає чи йде. Лише активний
 * учасник; майстер — 403 `FORBIDDEN` (він бачить зведення); сторонній чи колишній — 403
 * `NOT_A_MEMBER`; прихована гра для не-майстра — 404. Повтор — ідемпотентний upsert.
 * Блокування як у діях майстра: гра (FOR SHARE) → сесія (FOR SHARE), тож перенесення/
 * скасування сесії, виключення чи бан (X на грі) серіалізуються з RSVP.
 */
export async function setRsvp(
  deps: Pick<AppDeps, 'db'>,
  userId: number,
  sessionId: number,
  body: unknown,
): Promise<RsvpStatus> {
  const { status } = rsvpInputSchema.parse(body);
  const { db } = deps;
  const [r] = await db
    .select({ game: games })
    .from(gameSessions)
    .innerJoin(games, eq(games.id, gameSessions.gameId))
    .where(eq(gameSessions.id, sessionId));
  if (!r) throw new AppError(404, 'NOT_FOUND');
  if (r.game.gmUserId === userId) throw new AppError(403, 'FORBIDDEN');
  if (isHiddenFromNonGm(r.game)) throw new AppError(404, 'NOT_FOUND');
  const now = new Date();
  await db.transaction(async (tx) => {
    const [g] = await tx.select().from(games).where(eq(games.id, r.game.id)).for('share');
    if (!g) throw new AppError(404, 'NOT_FOUND');
    const [m] = await tx
      .select({ id: gameMembers.id })
      .from(gameMembers)
      .where(
        and(
          eq(gameMembers.gameId, g.id),
          eq(gameMembers.userId, userId),
          isNull(gameMembers.leftAt),
        ),
      );
    if (!m) throw new AppError(403, 'NOT_A_MEMBER');
    if (g.status !== 'recruiting' && g.status !== 'started') {
      throw new AppError(409, 'GAME_INVALID_TRANSITION');
    }
    const [s] = await tx
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.id, sessionId))
      .for('share');
    if (!s || s.status !== 'scheduled' || s.startsAt <= now) {
      throw new AppError(409, 'SESSION_INVALID_STATE');
    }
    await tx
      .insert(sessionRsvp)
      .values({ sessionId, userId, status, updatedAt: now })
      .onDuplicateKeyUpdate({ set: { status, updatedAt: now } });
  });
  return status;
}
