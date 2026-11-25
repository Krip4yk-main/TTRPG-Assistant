import { and, eq, isNull } from 'drizzle-orm';
import {
  GAME_CHANGED_EVENT,
  meetsAgeRating,
  type GameChangedPing,
  type GameChangeScope,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import { gameMembers, games } from '../db/schema/index.js';
import { viewerById } from '../games/games.service.js';
import { isHiddenFromNonGm, viewerAge } from '../games/games.visibility.js';

/** Усі, хто дивиться видиму гру (лише пінги `details`). */
export const gameRoom = (gameId: number): string => `game:${gameId}`;
/** Майстер і активні учасники (приватні пінги `sessions`, `members`). */
export const gameMembersRoom = (gameId: number): string => `game-members:${gameId}`;

export interface WatchAccess {
  /** Можна в `game:<id>`: опублікована (або своя) гра, вікова позначка пройдена. */
  watch: boolean;
  /** Можна в `game-members:<id>`: майстер або активний учасник нескасованої гри. */
  members: boolean;
}

/**
 * Право на кімнати гри — свіжо з БД при кожній підписці (колишній учасник уже не потрапить
 * у `game-members`). Ті самі правила, що в `toGameView`: прихована гра — лише майстру;
 * вікова позначка — за віком глядача (майстра не обмежує).
 */
export async function watchAccess(
  deps: Pick<AppDeps, 'db'>,
  userId: number,
  gameId: number,
): Promise<WatchAccess> {
  const none = { watch: false, members: false };
  const [g] = await deps.db
    .select({
      gmUserId: games.gmUserId,
      status: games.status,
      publishedAt: games.publishedAt,
      ageRating: games.ageRating,
    })
    .from(games)
    .where(eq(games.id, gameId));
  if (!g) return none;
  if (g.gmUserId === userId) return { watch: true, members: g.status !== 'cancelled' };
  if (isHiddenFromNonGm(g)) return none;
  if (g.ageRating !== 'none') {
    const viewer = await viewerById(deps, userId);
    if (!meetsAgeRating(viewerAge(viewer), g.ageRating)) return none;
  }
  if (g.status === 'cancelled') return { watch: true, members: false };
  const [m] = await deps.db
    .select({ id: gameMembers.id })
    .from(gameMembers)
    .where(
      and(
        eq(gameMembers.gameId, gameId),
        eq(gameMembers.userId, userId),
        isNull(gameMembers.leftAt),
      ),
    );
  return { watch: true, members: Boolean(m) };
}

/**
 * Куди йде пінг: `watchers` — `game:<id>`, `members` — `game-members:<id>`, або особисті
 * кімнати конкретних користувачів (дані лише для них, напр. заявки).
 */
export type PingTarget = 'watchers' | 'members' | { userIds: number[] };

/**
 * Пінг `game.changed` — рівно `{gameId, scope}`. Викликати ПІСЛЯ коміту. Без realtime
 * (тести, скрипти) — нічого; збій емісії не ламає запит.
 */
export function emitGameChanged(
  deps: Pick<Partial<AppDeps>, 'realtime'>,
  gameId: number,
  scope: GameChangeScope,
  target: PingTarget,
): void {
  const hub = deps.realtime;
  if (!hub) return;
  const ping: GameChangedPing = { gameId, scope };
  try {
    if (target === 'watchers') hub.toRoom(gameRoom(gameId), GAME_CHANGED_EVENT, ping);
    else if (target === 'members') hub.toRoom(gameMembersRoom(gameId), GAME_CHANGED_EVENT, ping);
    else for (const id of new Set(target.userIds)) hub.toUser(id, GAME_CHANGED_EVENT, ping);
  } catch (err) {
    console.error('[realtime] game.changed emit failed', err);
  }
}

/**
 * Склад гри змінився: `members` учасникам, `details` глядачам (`freeSlots`). Користувачі
 * `left` (вийшли/виключені/забанені) виходять із `game-members:<id>` на всіх вузлах і
 * отримують пінг особисто — щоб їхня сторінка перезапитала вже обмежений вид.
 */
export function membersChanged(
  deps: Pick<Partial<AppDeps>, 'realtime'>,
  gameId: number,
  left: number[] = [],
): void {
  for (const userId of left) {
    try {
      deps.realtime?.leaveRoom(userId, gameMembersRoom(gameId));
    } catch (err) {
      console.error('[realtime] leave room failed', err);
    }
  }
  emitGameChanged(deps, gameId, 'members', 'members');
  emitGameChanged(deps, gameId, 'details', 'watchers');
  if (left.length) emitGameChanged(deps, gameId, 'members', { userIds: left });
}

/** Новий учасник: його відкриті сокети одразу отримують приватні пінги гри. */
export function memberJoined(
  deps: Pick<Partial<AppDeps>, 'realtime'>,
  gameId: number,
  userId: number,
): void {
  try {
    deps.realtime?.joinRoom(userId, gameMembersRoom(gameId));
  } catch (err) {
    console.error('[realtime] join room failed', err);
  }
  membersChanged(deps, gameId);
}

/** Сесії гри змінились: `sessions` учасникам, `details` глядачам (`nextSessionAt`). */
export function sessionsChanged(deps: Pick<Partial<AppDeps>, 'realtime'>, gameId: number): void {
  emitGameChanged(deps, gameId, 'sessions', 'members');
  emitGameChanged(deps, gameId, 'details', 'watchers');
}

/** Заявки змінились: лише майстру й заявникам (дані заявок — не для інших). */
export function applicationsChanged(
  deps: Pick<Partial<AppDeps>, 'realtime'>,
  gameId: number,
  userIds: number[],
): void {
  emitGameChanged(deps, gameId, 'applications', { userIds });
}

/** Гру скасовано: приватних змін більше не буде — кімната учасників розпускається. */
export function closeMembersRoom(deps: Pick<Partial<AppDeps>, 'realtime'>, gameId: number): void {
  try {
    deps.realtime?.closeRoom(gameMembersRoom(gameId));
  } catch (err) {
    console.error('[realtime] close room failed', err);
  }
}
