import { and, desc, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import {
  adminDeadGameCloseSchema,
  adminDeadGameDismissSchema,
  adminDeadGamesQuerySchema,
  STALE_SNOOZE_DAYS,
  SUSPICIOUS_DISMISS_DAYS,
  type AdminDeadGameDto,
  type AdminPageDto,
  type GameAction,
  type GameTransitionDto,
  type MyDeadGameDto,
  type MyDeadGamesDto,
} from '@nri/shared';
import type { AppDeps } from '../../app.js';
import { games, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { writeLog } from '../../moderation/log.js';
import { assertCan, assertCanActOn, type Role } from '../../moderation/permissions.js';
import { actorRole } from '../../moderation/sanctions.service.js';
import {
  createNotification,
  emitNotificationsNew,
  type NotificationRow,
} from '../../notifications/notifications.service.js';
import { applyTransition, loadOwned } from '../games.service.js';
import {
  CHECKED_STATUSES,
  isChecked,
  keepUpdatedAt,
  sessionAnchors,
  staleAnchor,
  staleInputOf,
  stalenessOf,
} from './rules.js';

const DAY_MS = 86_400_000;
type GameRow = typeof games.$inferSelect;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Закриття «мертвої» гри: набір → скасована, гра, що йде, → завершена. */
function closeAction(row: GameRow): GameAction {
  if (row.status === 'recruiting') return 'cancel';
  if (row.status === 'started') return 'finish';
  throw new AppError(409, 'GAME_INVALID_TRANSITION');
}

type Anchors = Parameters<typeof staleInputOf>[1];

function toMyDto(row: GameRow, anchors: Anchors, now: Date): MyDeadGameDto {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    state: stalenessOf(row, anchors, now),
    suspicious: row.suspiciousAt !== null,
    lastActivityAt: iso(staleAnchor(staleInputOf(row, anchors))),
    deadAt: iso(row.deadAt),
    suspiciousAt: iso(row.suspiciousAt),
  };
}

async function freshRow(deps: Pick<AppDeps, 'db'>, id: number): Promise<GameRow> {
  const [row] = await deps.db.select().from(games).where(eq(games.id, id));
  if (!row) throw new AppError(404, 'NOT_FOUND');
  return row;
}

// ---------- майстер ----------

/**
 * `GET /api/me/dead-games`: ігри майстра (`recruiting`/`started`) зі станом `stale`/`dead`
 * або «підозрілі»; `deadGameIds` — ті, що блокують створення нової гри.
 */
export async function listMyDeadGames(
  deps: Pick<AppDeps, 'db'>,
  userId: number,
  now: Date = new Date(),
): Promise<MyDeadGamesDto> {
  const rows = await deps.db
    .select()
    .from(games)
    .where(and(eq(games.gmUserId, userId), inArray(games.status, CHECKED_STATUSES)))
    .orderBy(games.id);
  const anchors = await sessionAnchors(
    deps.db,
    rows.map((r) => r.id),
  );
  const items = rows
    .map((row) => toMyDto(row, anchors.get(row.id), now))
    .filter((i) => i.state !== 'ok' || i.suspicious);
  return { items, deadGameIds: items.filter((i) => i.state === 'dead').map((i) => i.id) };
}

/**
 * `POST /api/games/:id/still-alive` (майстер): «Все ок / система помилилась» — знімає
 * «мертвість» (гра повертається в пошук, блок створення знято) і відкладає нагадування й
 * позначку на 14 днів.
 */
export async function stillAlive(
  deps: AppDeps,
  userId: number,
  id: number,
  now: Date = new Date(),
): Promise<MyDeadGameDto> {
  const { row } = await loadOwned(deps, userId, id);
  if (!isChecked(row.status)) throw new AppError(409, 'GAME_INVALID_TRANSITION');
  const until = new Date(now.getTime() + STALE_SNOOZE_DAYS * DAY_MS);
  const [res] = await deps.db
    .update(games)
    .set({ deadAt: null, deadSnoozedUntil: until, ...keepUpdatedAt })
    .where(and(eq(games.id, id), inArray(games.status, CHECKED_STATUSES)));
  if (res.affectedRows === 0) throw new AppError(409, 'GAME_INVALID_TRANSITION');
  const anchors = (await sessionAnchors(deps.db, [id])).get(id);
  return toMyDto(await freshRow(deps, id), anchors, now);
}

/**
 * `POST /api/games/:id/close-dead` (майстер): закрити гру за правилом закриття — у наборі →
 * скасована, що йде → завершена (звичайні наслідки переходу).
 */
export async function closeDead(
  deps: AppDeps,
  userId: number,
  id: number,
): Promise<GameTransitionDto> {
  const { row } = await loadOwned(deps, userId, id);
  return applyTransition(deps, userId, row, closeAction(row));
}

// ---------- адміністрація ----------

type Staff = { userId: number; role: Role };

/** `GET /api/admin/dead-games?kind=dead|suspicious` (модератор+): новіші ігри першими. */
export async function listAdminDeadGames(
  deps: Pick<AppDeps, 'db'>,
  viewer: Staff,
  query: unknown,
): Promise<AdminPageDto<AdminDeadGameDto>> {
  assertCan(viewer.role, 'games.moderate');
  const { kind, cursor, limit } = adminDeadGamesQuerySchema.parse(query);
  const rows = await deps.db
    .select({
      row: games,
      gmPublicId: users.publicId,
      gmNickname: users.nickname,
      gmRole: users.role,
    })
    .from(games)
    .innerJoin(users, eq(users.id, games.gmUserId))
    .where(
      and(
        inArray(games.status, CHECKED_STATUSES),
        isNotNull(kind === 'dead' ? games.deadAt : games.suspiciousAt),
        cursor !== undefined ? lt(games.id, cursor) : undefined,
      ),
    )
    .orderBy(desc(games.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const anchors = await sessionAnchors(
    deps.db,
    page.map((r) => r.row.id),
  );
  return {
    items: page.map(({ row, gmPublicId, gmNickname, gmRole }) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      gm: { publicId: gmPublicId, nickname: gmNickname, role: gmRole },
      publishedAt: iso(row.publishedAt),
      lastActivityAt: iso(staleAnchor(staleInputOf(row, anchors.get(row.id)))),
      deadAt: iso(row.deadAt),
      suspiciousAt: iso(row.suspiciousAt),
    })),
    nextCursor: rows.length > limit ? page[page.length - 1]!.row.id : null,
  };
}

/**
 * Гра з позначкою для дії персоналу: роль з БД (модератор+), гра — `recruiting`/`started` з
 * потрібною позначкою (інакше 409), майстер — з нижчою роллю, ніж у того, хто діє (403).
 */
async function loadForStaff(
  deps: Pick<AppDeps, 'db'>,
  actorId: number,
  id: number,
  flagged: (row: GameRow) => boolean,
): Promise<GameRow> {
  const role = await actorRole(deps.db, actorId);
  assertCan(role, 'games.moderate');
  const row = await freshRow(deps, id);
  if (!isChecked(row.status) || !flagged(row)) throw new AppError(409, 'GAME_INVALID_TRANSITION');
  const [gm] = await deps.db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, row.gmUserId));
  assertCanActOn(role, gm?.role ?? 'user');
  return row;
}

/**
 * `POST /api/admin/dead-games/:id/close` (модератор+): закрити «мертву» чи «підозрілу» гру за
 * правилом закриття, з позначкою `closed_by_admin`; журнал `game.close` і сповіщення
 * `game.closed_by_admin` майстру — у транзакції переходу.
 */
export async function adminCloseDeadGame(
  deps: AppDeps,
  actorId: number,
  id: number,
  body: unknown,
): Promise<AdminDeadGameDto> {
  const { reason } = adminDeadGameCloseSchema.parse(body ?? {});
  const row = await loadForStaff(
    deps,
    actorId,
    id,
    (r) => r.deadAt !== null || r.suspiciousAt !== null,
  );
  const action = closeAction(row);
  let notified: NotificationRow | null = null;
  await applyTransition(deps, actorId, row, action, {
    inTx: async (tx) => {
      await writeLog(tx, {
        actorId,
        action: 'game.close',
        targetType: 'game',
        targetId: row.id,
        reason: reason || null,
        meta: {
          from: row.status,
          to: action === 'cancel' ? 'cancelled' : 'finished',
          dead: row.deadAt !== null,
          suspicious: row.suspiciousAt !== null,
        },
      });
      // Видаленому чи забаненому майстру сповіщення не шлемо (як і решта сповіщень детектора).
      const [gm] = await tx
        .select({ status: users.status, isBanned: users.isBanned })
        .from(users)
        .where(eq(users.id, row.gmUserId));
      if (gm?.status !== 'active' || gm.isBanned) return;
      notified = await createNotification(deps, tx, {
        userId: row.gmUserId,
        type: 'game.closed_by_admin',
        category: 'games',
        params: { gameId: row.id, gameTitle: row.title },
        entityType: 'game',
        entityId: row.id,
      });
    },
  });
  if (notified) emitNotificationsNew(deps, [notified]);
  return adminDto(deps, id);
}

/**
 * `POST /api/admin/dead-games/:id/dismiss {kind}` (модератор+): зняти позначку. «Мертва» —
 * гра звільнена від перевірки до наступної проведеної сесії; «підозріла» — позначка не
 * повертається 4 тижні. Журнал `game.dismiss_dead` / `game.dismiss_suspicious`.
 */
export async function adminDismissDeadGame(
  deps: AppDeps,
  actorId: number,
  id: number,
  body: unknown,
  now: Date = new Date(),
): Promise<AdminDeadGameDto> {
  const { kind, reason } = adminDeadGameDismissSchema.parse(body);
  await loadForStaff(deps, actorId, id, (r) =>
    kind === 'dead' ? r.deadAt !== null : r.suspiciousAt !== null,
  );
  await deps.db.transaction(async (tx) => {
    const flag = kind === 'dead' ? games.deadAt : games.suspiciousAt;
    const set =
      kind === 'dead'
        ? { deadAt: null, deadExemptUntilSession: true }
        : {
            suspiciousAt: null,
            suspiciousDismissedUntil: new Date(now.getTime() + SUSPICIOUS_DISMISS_DAYS * DAY_MS),
          };
    const [res] = await tx
      .update(games)
      .set({ ...set, ...keepUpdatedAt })
      .where(and(eq(games.id, id), inArray(games.status, CHECKED_STATUSES), isNotNull(flag)));
    if (res.affectedRows === 0) throw new AppError(409, 'GAME_INVALID_TRANSITION');
    await writeLog(tx, {
      actorId,
      action: kind === 'dead' ? 'game.dismiss_dead' : 'game.dismiss_suspicious',
      targetType: 'game',
      targetId: id,
      reason: reason || null,
    });
  });
  return adminDto(deps, id);
}

async function adminDto(deps: Pick<AppDeps, 'db'>, id: number): Promise<AdminDeadGameDto> {
  const [r] = await deps.db
    .select({ row: games, publicId: users.publicId, nickname: users.nickname, role: users.role })
    .from(games)
    .innerJoin(users, eq(users.id, games.gmUserId))
    .where(eq(games.id, id));
  if (!r) throw new AppError(404, 'NOT_FOUND');
  const anchors = (await sessionAnchors(deps.db, [id])).get(id);
  return {
    id,
    title: r.row.title,
    status: r.row.status,
    gm: { publicId: r.publicId, nickname: r.nickname, role: r.role },
    publishedAt: iso(r.row.publishedAt),
    lastActivityAt: iso(staleAnchor(staleInputOf(r.row, anchors))),
    deadAt: iso(r.row.deadAt),
    suspiciousAt: iso(r.row.suspiciousAt),
  };
}
