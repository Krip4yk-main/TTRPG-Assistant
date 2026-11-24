import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import {
  noteUpdateSchema,
  type NoteConflictDetails,
  type NoteDto,
  type NoteScope,
  type SharedNotesDto,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import { gameMembers, games, gameSessions, notes, users } from '../db/schema/index.js';
import { isHiddenFromNonGm } from '../games/games.visibility.js';
import { AppError } from '../http/errors.js';

type GameRow = typeof games.$inferSelect;
type NoteRow = typeof notes.$inferSelect;

const EMPTY: NoteDto = { body: '', version: 0, updatedAt: null };

function toDto(n: NoteRow | undefined): NoteDto {
  return n ? { body: n.body, version: n.version, updatedAt: n.updatedAt.toISOString() } : EMPTY;
}

/**
 * Гра для нотаток: невідома або прихована від не-майстра → 404; майстер → `gm`;
 * активний учасник → `player`; сторонній чи колишній → 403 `NOT_A_MEMBER`.
 */
async function accessGame(
  deps: AppDeps,
  userId: number,
  gameId: number,
): Promise<{ game: GameRow; role: 'gm' | 'player' }> {
  const [game] = await deps.db.select().from(games).where(eq(games.id, gameId));
  if (!game) throw new AppError(404, 'NOT_FOUND');
  if (game.gmUserId === userId) return { game, role: 'gm' };
  if (isHiddenFromNonGm(game)) throw new AppError(404, 'NOT_FOUND');
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
  if (!m) throw new AppError(403, 'NOT_A_MEMBER');
  return { game, role: 'player' };
}

const noteWhere = (
  scope: NoteScope,
  gameId: number,
  sessionId: number | null,
  userId: number,
): SQL | undefined =>
  and(
    eq(notes.scope, scope),
    eq(notes.gameId, gameId),
    sessionId === null ? isNull(notes.sessionId) : eq(notes.sessionId, sessionId),
    eq(notes.userId, userId),
  );

async function readOwn(
  deps: AppDeps,
  scope: NoteScope,
  gameId: number,
  sessionId: number | null,
  userId: number,
): Promise<NoteDto> {
  const [n] = await deps.db
    .select()
    .from(notes)
    .where(noteWhere(scope, gameId, sessionId, userId));
  return toDto(n);
}

/**
 * Оптимістичний запис: `version` 0 — вставка (дубль ключа → конфлікт), інакше умовний
 * UPDATE `WHERE version = ?`; рівно один із двох паралельних записів з однаковою версією
 * проходить, інший отримує 409 з актуальним текстом.
 */
async function writeOwn(
  deps: AppDeps,
  scope: NoteScope,
  gameId: number,
  sessionId: number | null,
  userId: number,
  rawBody: unknown,
): Promise<NoteDto> {
  const input = noteUpdateSchema.parse(rawBody);
  let ok: boolean;
  if (input.version === 0) {
    const [res] = await deps.db
      .insert(notes)
      .ignore()
      .values({ scope, gameId, sessionId, userId, body: input.body, version: 1 });
    ok = res.affectedRows > 0;
  } else {
    const [res] = await deps.db
      .update(notes)
      .set({ body: input.body, version: input.version + 1 })
      .where(and(noteWhere(scope, gameId, sessionId, userId), eq(notes.version, input.version)));
    ok = res.affectedRows > 0;
  }
  const current = await readOwn(deps, scope, gameId, sessionId, userId);
  if (!ok) {
    const details: NoteConflictDetails = { body: current.body, version: current.version };
    throw new AppError(409, 'NOTE_CONFLICT', details);
  }
  return current;
}

// ---------- спільна нотатка гравців ----------

/** Сторінки всіх активних гравців (порожні, якщо ще нічого немає) і колишніх — лише з текстом. */
export async function getSharedNotes(
  deps: AppDeps,
  userId: number,
  gameId: number,
): Promise<SharedNotesDto> {
  const { role } = await accessGame(deps, userId, gameId);
  if (role === 'gm') throw new AppError(403, 'FORBIDDEN');
  const members = await deps.db
    .select({ userId: gameMembers.userId, leftAt: gameMembers.leftAt })
    .from(gameMembers)
    .where(eq(gameMembers.gameId, gameId))
    .orderBy(asc(gameMembers.joinedAt), asc(gameMembers.id));
  // Користувач міг вийти й повернутися: активним вважаємо, якщо є хоч одне відкрите членство.
  const active = new Set(members.filter((m) => m.leftAt === null).map((m) => m.userId));
  const order = [...new Set(members.map((m) => m.userId))];
  const rows = await deps.db
    .select()
    .from(notes)
    .where(and(eq(notes.scope, 'game_shared'), eq(notes.gameId, gameId)));
  const byUser = new Map(rows.map((r) => [r.userId, r]));
  const authors = order.length
    ? await deps.db
        .select({
          id: users.id,
          publicId: users.publicId,
          nickname: users.nickname,
          avatarUrl: users.avatarUrl,
        })
        .from(users)
        .where(inArray(users.id, order))
    : [];
  const authorById = new Map(authors.map((a) => [a.id, a]));
  const pages: SharedNotesDto['pages'] = [];
  const ordered = [...order.filter((u) => active.has(u)), ...order.filter((u) => !active.has(u))];
  for (const uid of ordered) {
    const note = byUser.get(uid);
    const formerMember = !active.has(uid);
    const a = authorById.get(uid);
    if (!a || (formerMember && !note)) continue;
    pages.push({
      author: { publicId: a.publicId, nickname: a.nickname, avatarUrl: a.avatarUrl },
      formerMember,
      ...toDto(note),
    });
  }
  return { pages };
}

export async function putSharedNote(
  deps: AppDeps,
  userId: number,
  gameId: number,
  body: unknown,
): Promise<NoteDto> {
  const { role } = await accessGame(deps, userId, gameId);
  if (role === 'gm') throw new AppError(403, 'FORBIDDEN');
  return writeOwn(deps, 'game_shared', gameId, null, userId, body);
}

// ---------- приватні ----------

export async function getGamePrivateNote(
  deps: AppDeps,
  userId: number,
  gameId: number,
): Promise<NoteDto> {
  await accessGame(deps, userId, gameId);
  return readOwn(deps, 'game_private', gameId, null, userId);
}

export async function putGamePrivateNote(
  deps: AppDeps,
  userId: number,
  gameId: number,
  body: unknown,
): Promise<NoteDto> {
  await accessGame(deps, userId, gameId);
  return writeOwn(deps, 'game_private', gameId, null, userId, body);
}

async function sessionGameId(deps: AppDeps, sessionId: number): Promise<number> {
  const [s] = await deps.db
    .select({ gameId: gameSessions.gameId })
    .from(gameSessions)
    .where(eq(gameSessions.id, sessionId));
  if (!s) throw new AppError(404, 'NOT_FOUND');
  return s.gameId;
}

export async function getSessionNote(
  deps: AppDeps,
  userId: number,
  sessionId: number,
): Promise<NoteDto> {
  const gameId = await sessionGameId(deps, sessionId);
  await accessGame(deps, userId, gameId);
  return readOwn(deps, 'session_private', gameId, sessionId, userId);
}

export async function putSessionNote(
  deps: AppDeps,
  userId: number,
  sessionId: number,
  body: unknown,
): Promise<NoteDto> {
  const gameId = await sessionGameId(deps, sessionId);
  await accessGame(deps, userId, gameId);
  return writeOwn(deps, 'session_private', gameId, sessionId, userId, body);
}
