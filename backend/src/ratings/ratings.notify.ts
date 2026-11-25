import { inArray } from 'drizzle-orm';
import type { NotificationParams, NotificationType } from '@nri/shared';
import { games, users } from '../db/schema/index.js';
import type { EventRow, NewNotification } from '../notifications/recipients.js';
import { openRatingSets, type OpenRatingSet, type Q } from './ratings.eligibility.js';

type Payload = Record<string, unknown>;
const asPayload = (p: unknown): Payload =>
  p && typeof p === 'object' && !Array.isArray(p) ? (p as Payload) : {};
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;

/** Подія, що запрошує оцінити: гра, сесія (для `session.done`) і хто вийшов (для виходу). */
interface Trigger {
  ev: EventRow;
  gameId: number;
  sessionId?: number;
  leaverId?: number;
}

function triggerOf(ev: EventRow): Trigger | null {
  const p = asPayload(ev.payload);
  switch (ev.type) {
    case 'session.done': {
      const gameId = num(p.gameId);
      const sessionId = ev.entityType === 'session' ? num(ev.entityId) : undefined;
      return gameId && sessionId ? { ev, gameId, sessionId } : null;
    }
    case 'game.finished':
    case 'game.cancelled': {
      // Скасована гра: підсумковий набір — лише «вихідні» пари (з дедлайном 30 днів).
      const gameId = ev.entityType === 'game' ? num(ev.entityId) : undefined;
      return gameId ? { ev, gameId } : null;
    }
    case 'member.left':
    case 'member.kicked':
    case 'member.banned': {
      const gameId = ev.entityType === 'game' ? num(ev.entityId) : num(p.gameId);
      // Хто вийшов: сам автор події (`left`) або учасник, над яким дія майстра.
      const leaverId = ev.type === 'member.left' ? num(ev.userId) : num(p.memberId);
      // Бан не-учасника нікого з гри не прибрав.
      if (ev.type === 'member.banned' && p.wasMember !== true) return null;
      return gameId && leaverId ? { ev, gameId, leaverId } : null;
    }
    default:
      return null;
  }
}

/**
 * Запрошення оцінити з подій (категорія `ratings`, окремо від сповіщень самих подій — тому
 * UNIQUE сповіщень включає категорію). Стан — на момент обробки (`now`):
 * - `session.done` → `rating.session_open` кожному присутньому, у кого в сесійному наборі є
 *   кого оцінити;
 * - `game.finished` / `game.cancelled` → `rating.final_open` кожному (зокрема тим, хто
 *   вийшов), у кого в підсумковому наборі є `open` цілі (у скасованій — лише «вихідні» пари);
 * - вихід/виключення/бан → `rating.member_left` (`ratee` — той, хто вийшов) кожному, хто грав
 *   із ним і ще не оцінив його й не відмовився; а тому, хто вийшов, — `rating.final_open`,
 *   якщо йому є кого оцінити.
 * Автор дії не виключається: майстер, що виключив гравця, теж може його оцінити.
 */
export async function planRatingNotifications(
  q: Q,
  batch: EventRow[],
  now: Date = new Date(),
): Promise<NewNotification[]> {
  const triggers = batch.flatMap((ev) => triggerOf(ev) ?? []);
  if (triggers.length === 0) return [];
  const gameIds = [...new Set(triggers.map((t) => t.gameId))];
  const sets = await openRatingSets(q, gameIds, now);
  if (sets.length === 0) return [];

  const titleRows = await q
    .select({ id: games.id, title: games.title })
    .from(games)
    .where(inArray(games.id, gameIds));
  const titleOf = new Map(titleRows.map((g) => [g.id, g.title]));
  const leaverIds = [...new Set(triggers.flatMap((t) => t.leaverId ?? []))];
  const leavers = leaverIds.length
    ? await q
        .select({ id: users.id, publicId: users.publicId, nickname: users.nickname })
        .from(users)
        .where(inArray(users.id, leaverIds))
    : [];
  const leaverById = new Map(leavers.map((u) => [u.id, u]));

  const setsOf = (gameId: number, sessionId: number | null) =>
    sets.filter((s) => s.gameId === gameId && s.sessionId === sessionId);
  const out: NewNotification[] = [];
  const push = (t: Trigger, s: OpenRatingSet, type: NotificationType, extra = {}) => {
    const params: NotificationParams = {
      gameId: s.gameId,
      gameTitle: titleOf.get(s.gameId) ?? null,
      ...(s.sessionId !== null ? { sessionId: s.sessionId } : {}),
      ...(s.closesAt ? { closesAt: s.closesAt.toISOString() } : {}),
      ...extra,
    };
    out.push({
      eventId: t.ev.id,
      userId: s.raterId,
      type,
      category: 'ratings',
      params,
      entityType: t.ev.entityType,
      entityId: t.ev.entityId,
    });
  };

  for (const t of triggers) {
    if (t.sessionId !== undefined) {
      for (const s of setsOf(t.gameId, t.sessionId)) push(t, s, 'rating.session_open');
    } else if (t.leaverId === undefined) {
      for (const s of setsOf(t.gameId, null)) push(t, s, 'rating.final_open');
    } else {
      const leaver = leaverById.get(t.leaverId);
      for (const s of setsOf(t.gameId, null)) {
        if (s.raterId === t.leaverId) {
          push(t, s, 'rating.final_open');
        } else if (leaver && s.openRateeIds.includes(t.leaverId)) {
          push(t, s, 'rating.member_left', {
            ratee: { publicId: leaver.publicId, nickname: leaver.nickname },
          });
        }
      }
    }
  }
  return out;
}
