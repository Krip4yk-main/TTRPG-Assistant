import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  applicationInputSchema,
  constraintResponseInputSchema,
  meetsAgeRating,
  type ApplicationDto,
  type ConstraintResponse,
  type GameApplicationDto,
  type MyApplicationDto,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import { isDuplicateKey } from '../db/errors.js';
import {
  applicationConstraintResponses,
  gameApplications,
  gameBans,
  gameContentWarnings,
  gameMembers,
  games,
  gmBlacklist,
  users,
} from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import { loadGames, toCardDto, viewerById } from '../games/games.service.js';
import { isHiddenFromNonGm, toCardView, viewerAge } from '../games/games.visibility.js';
import { AppError } from '../http/errors.js';
import { lockUser, type Tx } from './applications.rules.js';

type ApplicationRow = typeof gameApplications.$inferSelect;
type GameRow = typeof games.$inferSelect;

/** 8 символів base64url із 6 випадкових байтів. */
const constraintId = (): string => randomBytes(6).toString('base64url');

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

// ---------- DTO ----------

type Answer = { response: ConstraintResponse; comment: string | null };

async function responsesOf(
  deps: AppDeps,
  ids: number[],
): Promise<Map<number, Map<string, Answer>>> {
  const out = new Map<number, Map<string, Answer>>();
  if (ids.length === 0) return out;
  const rows = await deps.db
    .select()
    .from(applicationConstraintResponses)
    .where(inArray(applicationConstraintResponses.applicationId, ids));
  for (const r of rows) {
    let m = out.get(r.applicationId);
    if (!m) out.set(r.applicationId, (m = new Map()));
    m.set(r.constraintId, { response: r.response, comment: r.comment });
  }
  return out;
}

function toDto(row: ApplicationRow, responses: Map<string, Answer> | undefined): ApplicationDto {
  return {
    id: row.id,
    gameId: row.gameId,
    status: row.status,
    message: row.message,
    answers: row.answers,
    constraints: row.constraints.map((c) => {
      const r = responses?.get(c.id);
      return {
        id: c.id,
        text: c.text,
        response: r?.response ?? null,
        comment: r?.comment ?? null,
      };
    }),
    cancelReason: row.cancelReason,
    createdAt: row.createdAt.toISOString(),
    decidedAt: iso(row.decidedAt),
  };
}

async function dtoById(deps: AppDeps, id: number): Promise<ApplicationDto> {
  const [row] = await deps.db.select().from(gameApplications).where(eq(gameApplications.id, id));
  if (!row) throw new AppError(404, 'NOT_FOUND');
  return toDto(row, (await responsesOf(deps, [id])).get(id));
}

// ---------- перевірки ----------

/** Заявки приймаються в `recruiting` і в `started` з `showWhenFull`. */
const acceptsApplications = (g: GameRow): boolean =>
  g.status === 'recruiting' || (g.status === 'started' && g.showWhenFull);

/**
 * Гра під спільним блокуванням: підняття вікової позначки й скасування гри (X-блокування)
 * чекають на заявку/затвердження й навпаки. Неопублікована гра — 404.
 */
async function lockGame(tx: Tx, gameId: number): Promise<GameRow> {
  const [g] = await tx.select().from(games).where(eq(games.id, gameId)).for('share');
  if (!g || isHiddenFromNonGm(g)) throw new AppError(404, 'NOT_FOUND');
  return g;
}

async function isBannedInGame(tx: Tx, gameId: number, userId: number): Promise<boolean> {
  const [ban] = await tx
    .select({ id: gameBans.userId })
    .from(gameBans)
    .where(and(eq(gameBans.gameId, gameId), eq(gameBans.userId, userId)));
  return Boolean(ban);
}

async function isActiveMember(tx: Tx, gameId: number, userId: number): Promise<boolean> {
  const [m] = await tx
    .select({ id: gameMembers.id })
    .from(gameMembers)
    .where(
      and(
        eq(gameMembers.gameId, gameId),
        eq(gameMembers.userId, userId),
        isNull(gameMembers.leftAt),
      ),
    );
  return Boolean(m);
}

async function hasWarnings(tx: Tx, g: GameRow): Promise<boolean> {
  if (g.customWarnings.length) return true;
  const [w] = await tx
    .select({ id: gameContentWarnings.warningId })
    .from(gameContentWarnings)
    .where(eq(gameContentWarnings.gameId, g.id))
    .limit(1);
  return Boolean(w);
}

/** Заявка, якою керує майстер її гри: чужа → 403, неіснуюча → 404. */
async function loadForGm(deps: AppDeps, gmUserId: number, id: number): Promise<ApplicationRow> {
  const [row] = await deps.db
    .select({ app: gameApplications, gmUserId: games.gmUserId })
    .from(gameApplications)
    .innerJoin(games, eq(games.id, gameApplications.gameId))
    .where(eq(gameApplications.id, id));
  if (!row) throw new AppError(404, 'NOT_FOUND');
  if (row.gmUserId !== gmUserId) throw new AppError(403, 'FORBIDDEN');
  return row.app;
}

// ---------- операції ----------

export async function createApplication(
  deps: AppDeps,
  userId: number,
  gameId: number,
  body: unknown,
): Promise<ApplicationDto> {
  const { db } = deps;
  const input = applicationInputSchema.parse(body);
  const now = new Date();
  let id: number;
  try {
    id = await db.transaction(async (tx) => {
      // Порядок блокувань: гра → користувач → заявки (див. `lockUser`).
      const g = await lockGame(tx, gameId);
      const u = await lockUser(tx, userId);
      if (!u || u.status === 'deleted') throw new AppError(404, 'NOT_FOUND');
      if (u.isBanned) throw new AppError(403, 'ACCOUNT_BANNED');
      const isGm = g.gmUserId === userId;
      // Вік — до перевірки набору: неповнолітній не дізнається, чи гра ще набирає.
      const viewer = { userId, birthDate: u.birthDate, timezone: u.timezone };
      if (!isGm && !meetsAgeRating(viewerAge(viewer, now), g.ageRating)) {
        throw new AppError(403, 'AGE_RESTRICTED_APPLY');
      }
      if (!acceptsApplications(g)) throw new AppError(409, 'APPLICATION_CLOSED');
      if (isGm) throw new AppError(403, 'FORBIDDEN');
      if (await isBannedInGame(tx, gameId, userId)) throw new AppError(403, 'BANNED_FROM_GAME');
      const [black] = await tx
        .select({ id: gmBlacklist.userId })
        .from(gmBlacklist)
        .where(and(eq(gmBlacklist.gmUserId, g.gmUserId), eq(gmBlacklist.userId, userId)));
      if (black) throw new AppError(403, 'GM_BLACKLISTED');
      if (await isActiveMember(tx, gameId, userId)) throw new AppError(409, 'APPLICATION_EXISTS');
      if (input.warningsAccepted !== true && (await hasWarnings(tx, g))) {
        throw new AppError(400, 'WARNINGS_NOT_ACCEPTED');
      }
      const questions = g.applicationQuestions;
      if (input.answers.length !== questions.length || input.answers.some((a) => a === '')) {
        throw new AppError(400, 'ANSWERS_REQUIRED');
      }
      // Дубль активної заявки ловить унікальний `active_key` (ER_DUP_ENTRY → 409 нижче).
      const [res] = await tx
        .insert(gameApplications)
        .values({
          gameId,
          userId,
          message: input.message,
          answers: input.answers,
          constraints: input.constraints.map((text) => ({ id: constraintId(), text })),
          warningsAcceptedAt: now,
        })
        .$returningId();
      return res!.id;
    });
  } catch (err) {
    if (isDuplicateKey(err)) throw new AppError(409, 'APPLICATION_EXISTS');
    throw err;
  }
  await logEvent(db, {
    type: 'application.created',
    userId,
    entityType: 'application',
    entityId: id,
    payload: { gameId },
  });
  return dtoById(deps, id);
}

/** Відкликання своєї `pending`-заявки. Чужа чи неіснуюча — 404. */
export async function withdrawApplication(
  deps: AppDeps,
  userId: number,
  id: number,
): Promise<ApplicationDto> {
  const { db } = deps;
  const [row] = await db
    .select()
    .from(gameApplications)
    .where(and(eq(gameApplications.id, id), eq(gameApplications.userId, userId)));
  if (!row) throw new AppError(404, 'NOT_FOUND');
  const [res] = await db
    .update(gameApplications)
    .set({ status: 'withdrawn', decidedAt: new Date() })
    .where(and(eq(gameApplications.id, id), eq(gameApplications.status, 'pending')));
  if (res.affectedRows === 0) throw new AppError(409, 'APPLICATION_CLOSED');
  await logEvent(db, {
    type: 'application.withdrawn',
    userId,
    entityType: 'application',
    entityId: id,
    payload: { gameId: row.gameId },
  });
  return dtoById(deps, id);
}

/**
 * Затвердження: транзакція з блокуваннями «гра (FOR SHARE) → заявник (FOR SHARE) → заявка
 * (FOR UPDATE)» — той самий порядок, що в підняття позначки, бан у грі (гра X) і видалення
 * акаунта (ігри → користувач), тож без взаємоблокувань. Бан у грі перевіряється під
 * блокуванням гри. Межу `maxPlayers` не перевіряємо (рішення власника); вік — так.
 */
export async function approveApplication(
  deps: AppDeps,
  gmUserId: number,
  id: number,
): Promise<ApplicationDto> {
  const { db } = deps;
  const app = await loadForGm(deps, gmUserId, id);
  const now = new Date();
  try {
    await db.transaction(async (tx) => {
      const g = await lockGame(tx, app.gameId);
      const u = await lockUser(tx, app.userId);
      const [locked] = await tx
        .select()
        .from(gameApplications)
        .where(eq(gameApplications.id, id))
        .for('update');
      if (!locked || locked.status !== 'pending') throw new AppError(409, 'APPLICATION_CLOSED');
      if (!u || u.status === 'deleted' || u.isBanned) {
        throw new AppError(409, 'APPLICATION_CLOSED');
      }
      if (g.status !== 'recruiting' && g.status !== 'started') {
        throw new AppError(409, 'APPLICATION_CLOSED');
      }
      if (await isBannedInGame(tx, g.id, app.userId)) {
        throw new AppError(403, 'BANNED_FROM_GAME');
      }
      const applicant = { userId: app.userId, birthDate: u.birthDate, timezone: u.timezone };
      if (!meetsAgeRating(viewerAge(applicant, now), g.ageRating)) {
        throw new AppError(403, 'AGE_RESTRICTED_APPLY');
      }
      // Активне членство вже є → ER_DUP_ENTRY на `game_members_active_uq` → 409 нижче.
      await tx
        .insert(gameMembers)
        .values({ gameId: app.gameId, userId: app.userId, applicationId: id, joinedAt: now });
      await tx
        .update(gameApplications)
        .set({ status: 'approved', decidedAt: now, decidedBy: gmUserId })
        .where(eq(gameApplications.id, id));
    });
  } catch (err) {
    if (isDuplicateKey(err)) throw new AppError(409, 'APPLICATION_EXISTS');
    throw err;
  }
  await logEvent(db, {
    type: 'application.approved',
    userId: gmUserId,
    entityType: 'application',
    entityId: id,
    payload: { gameId: app.gameId, applicantId: app.userId },
  });
  return dtoById(deps, id);
}

export async function rejectApplication(
  deps: AppDeps,
  gmUserId: number,
  id: number,
): Promise<ApplicationDto> {
  const { db } = deps;
  const app = await loadForGm(deps, gmUserId, id);
  const [res] = await db
    .update(gameApplications)
    .set({ status: 'rejected', decidedAt: new Date(), decidedBy: gmUserId })
    .where(and(eq(gameApplications.id, id), eq(gameApplications.status, 'pending')));
  if (res.affectedRows === 0) throw new AppError(409, 'APPLICATION_CLOSED');
  await logEvent(db, {
    type: 'application.rejected',
    userId: gmUserId,
    entityType: 'application',
    entityId: id,
    payload: { gameId: app.gameId, applicantId: app.userId },
  });
  return dtoById(deps, id);
}

/** Відповідь майстра на обмеження — до й після затвердження (`pending`/`approved`). */
export async function respondToConstraint(
  deps: AppDeps,
  gmUserId: number,
  id: number,
  constraintIdParam: string,
  body: unknown,
): Promise<ApplicationDto> {
  const input = constraintResponseInputSchema.parse(body);
  const app = await loadForGm(deps, gmUserId, id);
  if (!app.constraints.some((c) => c.id === constraintIdParam)) {
    throw new AppError(404, 'NOT_FOUND');
  }
  if (app.status !== 'pending' && app.status !== 'approved') {
    throw new AppError(409, 'APPLICATION_CLOSED');
  }
  const values = { response: input.response, comment: input.comment };
  await deps.db
    .insert(applicationConstraintResponses)
    .values({ applicationId: id, constraintId: constraintIdParam, ...values })
    .onDuplicateKeyUpdate({ set: values });
  return dtoById(deps, id);
}

/** «Мої заявки»: з карткою гри (вікові правила — `toCardView`). */
export async function listMyApplications(
  deps: AppDeps,
  userId: number,
): Promise<MyApplicationDto[]> {
  const { db } = deps;
  const rows = await db
    .select()
    .from(gameApplications)
    .where(eq(gameApplications.userId, userId))
    .orderBy(desc(gameApplications.createdAt), desc(gameApplications.id));
  if (rows.length === 0) return [];
  const gameIds = [...new Set(rows.map((r) => r.gameId))];
  const [loaded, responses, viewer] = await Promise.all([
    loadGames(deps, inArray(games.id, gameIds)),
    responsesOf(
      deps,
      rows.map((r) => r.id),
    ),
    viewerById(deps, userId),
  ]);
  const now = new Date();
  const cards = new Map(
    loaded.map((l) => [l.row.id, toCardView(toCardDto(l, now), l.row.gmUserId, viewer, now)]),
  );
  return rows.flatMap((r) => {
    const game = cards.get(r.gameId);
    return game ? [{ ...toDto(r, responses.get(r.id)), game }] : [];
  });
}

/** Заявки на гру — лише майстру; вік заявника не розкривається, лише `meetsAgeRating`. */
export async function listGameApplications(
  deps: AppDeps,
  gmUserId: number,
  gameId: number,
): Promise<GameApplicationDto[]> {
  const { db } = deps;
  const [g] = await db.select().from(games).where(eq(games.id, gameId));
  if (!g) throw new AppError(404, 'NOT_FOUND');
  if (g.gmUserId !== gmUserId) {
    throw isHiddenFromNonGm(g) ? new AppError(404, 'NOT_FOUND') : new AppError(403, 'FORBIDDEN');
  }
  const rows = await db
    .select({
      app: gameApplications,
      publicId: users.publicId,
      nickname: users.nickname,
      avatarUrl: users.avatarUrl,
      birthDate: users.birthDate,
      timezone: users.timezone,
    })
    .from(gameApplications)
    .innerJoin(users, eq(users.id, gameApplications.userId))
    .where(eq(gameApplications.gameId, gameId))
    .orderBy(asc(gameApplications.createdAt), asc(gameApplications.id));
  const responses = await responsesOf(
    deps,
    rows.map((r) => r.app.id),
  );
  const now = new Date();
  return rows.map((r) => ({
    ...toDto(r.app, responses.get(r.app.id)),
    applicant: { publicId: r.publicId, nickname: r.nickname, avatarUrl: r.avatarUrl },
    meetsAgeRating: meetsAgeRating(
      viewerAge({ userId: r.app.userId, birthDate: r.birthDate, timezone: r.timezone }, now),
      g.ageRating,
    ),
  }));
}
