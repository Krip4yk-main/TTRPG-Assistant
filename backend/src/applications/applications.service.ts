import { randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  APPLICATION_QUICK_WITHDRAW_MS,
  APPLICATION_REJECT_COOLDOWN_MS,
  APPLICATION_WITHDRAW_COOLDOWN_MS,
  applicationInputSchema,
  type ApplicationCooldownDetails,
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
  events,
  gameApplications,
  gameBans,
  gameContentWarnings,
  gameMembers,
  games,
  gmBlacklist,
  notifications,
  users,
} from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import { emitNotificationsNew } from '../notifications/notifications.service.js';
import { loadGames, toCardDto, viewerById } from '../games/games.service.js';
import { isHiddenFromNonGm, toCardView, viewerAge } from '../games/games.visibility.js';
import { AppError } from '../http/errors.js';
import { lockUser, type Tx } from './applications.rules.js';
import {
  activeSanctionEnds,
  isPaid,
  sanctionActiveError,
} from '../moderation/sanctions.enforce.js';
import { applicationsChanged, memberJoined } from '../realtime/game-rooms.js';
import { markOwnChange, seenFor } from '../views/views.service.js';

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

/**
 * Після коміту зміни заявки: для автора дії вона переглянута (власна зміна — не
 * «оновлення»); пінг `applications` — лише майстру гри й автору заявки.
 */
async function afterChange(
  deps: AppDeps,
  actorId: number,
  applicationId: number,
  gameId: number,
  otherUserId?: number,
): Promise<void> {
  await markOwnChange(deps, actorId, 'application', [applicationId]);
  const gmUserId =
    otherUserId === undefined
      ? (
          await deps.db.select({ gmUserId: games.gmUserId }).from(games).where(eq(games.id, gameId))
        )[0]?.gmUserId
      : undefined;
  applicationsChanged(
    deps,
    gameId,
    [actorId, otherUserId ?? gmUserId].filter((u): u is number => u !== undefined),
  );
}

/**
 * Санкції проти нової заявки (наявні заявки й участь не чіпаються): `application_limit` — уже є
 * хоч одна заявка в статусі `pending` (членства не рахуються); `no_paid_apply` — гра платна.
 */
async function assertApplySanctions(tx: Tx, userId: number, g: GameRow, now: Date): Promise<void> {
  const ends = await activeSanctionEnds(tx, userId, now);
  if (ends.has('application_limit')) {
    const [p] = await tx
      .select({ n: count() })
      .from(gameApplications)
      .where(and(eq(gameApplications.userId, userId), eq(gameApplications.status, 'pending')));
    if ((p?.n ?? 0) >= 1) {
      throw sanctionActiveError('application_limit', ends.get('application_limit')!);
    }
  }
  if (ends.has('no_paid_apply') && isPaid(g.priceUah)) {
    throw sanctionActiveError('no_paid_apply', ends.get('no_paid_apply')!);
  }
}

/**
 * Кулдаун повторної заявки на ту саму гру: після власного відкликання — 10 хв, після
 * відхилення майстром — 24 год (від `decided_at`). Прострочені й скасовані системою заявки
 * кулдауну не дають; інші ігри — теж. Інакше 409 `APPLICATION_COOLDOWN` з `retryAt`.
 */
async function assertNoCooldown(tx: Tx, userId: number, gameId: number, now: Date): Promise<void> {
  const since = new Date(now.getTime() - APPLICATION_REJECT_COOLDOWN_MS);
  const rows = await tx
    .select({ status: gameApplications.status, decidedAt: gameApplications.decidedAt })
    .from(gameApplications)
    .where(
      and(
        eq(gameApplications.gameId, gameId),
        eq(gameApplications.userId, userId),
        inArray(gameApplications.status, ['withdrawn', 'rejected']),
        isNotNull(gameApplications.decidedAt),
        gt(gameApplications.decidedAt, since),
      ),
    );
  let retryAt = 0;
  for (const r of rows) {
    const wait =
      r.status === 'rejected' ? APPLICATION_REJECT_COOLDOWN_MS : APPLICATION_WITHDRAW_COOLDOWN_MS;
    retryAt = Math.max(retryAt, r.decidedAt!.getTime() + wait);
  }
  if (retryAt > now.getTime()) {
    const details: ApplicationCooldownDetails = { retryAt: new Date(retryAt).toISOString() };
    throw new AppError(409, 'APPLICATION_COOLDOWN', details);
  }
}

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
      // Порядок блокувань: гра → користувач → заявки (див. `lockUser`). Користувач — X: заявки
      // однієї людини на різні ігри серіалізуються (ліміт `application_limit` рахує `pending`).
      const g = await lockGame(tx, gameId);
      const u = await lockUser(tx, userId, 'update');
      if (!u || u.status === 'deleted') throw new AppError(404, 'NOT_FOUND');
      if (u.isBanned) throw new AppError(403, 'ACCOUNT_BANNED');
      const isGm = g.gmUserId === userId;
      // Вік — до перевірки набору: неповнолітній не дізнається, чи гра ще набирає.
      const viewer = { userId, birthDate: u.birthDate, timezone: u.timezone };
      if (!isGm && !meetsAgeRating(viewerAge(viewer, now), g.ageRating)) {
        throw new AppError(403, 'AGE_RESTRICTED_APPLY');
      }
      // Кампейн на паузі: окремий код, щоб інтерфейс пояснив причину.
      if (g.status === 'paused') throw new AppError(409, 'GAME_PAUSED');
      if (!acceptsApplications(g)) throw new AppError(409, 'APPLICATION_CLOSED');
      if (isGm) throw new AppError(403, 'FORBIDDEN');
      if (await isBannedInGame(tx, gameId, userId)) throw new AppError(403, 'BANNED_FROM_GAME');
      const [black] = await tx
        .select({ id: gmBlacklist.userId })
        .from(gmBlacklist)
        .where(and(eq(gmBlacklist.gmUserId, g.gmUserId), eq(gmBlacklist.userId, userId)));
      if (black) throw new AppError(403, 'GM_BLACKLISTED');
      if (await isActiveMember(tx, gameId, userId)) throw new AppError(409, 'APPLICATION_EXISTS');
      await assertNoCooldown(tx, userId, gameId, now);
      await assertApplySanctions(tx, userId, g, now);
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
  await afterChange(deps, userId, id, gameId);
  return dtoById(deps, id);
}

/**
 * Відкликання своєї `pending`-заявки. Чужа чи неіснуюча — 404.
 *
 * Швидке відкликання (заявка подана < `APPLICATION_QUICK_WITHDRAW_MS` тому) майстра не турбує:
 * подія `application.withdrawn` іде з `quick: true` (диспетчер її не розсилає), ще не розіслана
 * подія `application.created` позначається обробленою (без сповіщень), а вже створене
 * непрочитане «нова заявка» видаляється — разом із рядком `telegram_outbox` (каскад FK). Прочитане
 * лишається: майстер його вже бачив. Видалення, а не «прочитано»: сповіщення про заявку, якої
 * вже немає, — шум, а історія лишається в подіях. Після коміту — пінг `notification.new`
 * майстру: його вкладки перечитують лічильник.
 */
export async function withdrawApplication(
  deps: AppDeps,
  userId: number,
  id: number,
): Promise<ApplicationDto> {
  const { db } = deps;
  const [row] = await db
    .select({ app: gameApplications, gmUserId: games.gmUserId })
    .from(gameApplications)
    .innerJoin(games, eq(games.id, gameApplications.gameId))
    .where(and(eq(gameApplications.id, id), eq(gameApplications.userId, userId)));
  if (!row) throw new AppError(404, 'NOT_FOUND');
  const now = new Date();
  const quick = now.getTime() - row.app.createdAt.getTime() < APPLICATION_QUICK_WITHDRAW_MS;
  // READ COMMITTED (як у диспетчера): без gap-блокувань, блокувальні читання бачать закомічене.
  const removed = await db.transaction(
    async (tx) => {
      const [res] = await tx
        .update(gameApplications)
        .set({ status: 'withdrawn', decidedAt: now })
        .where(and(eq(gameApplications.id, id), eq(gameApplications.status, 'pending')));
      if (res.affectedRows === 0) throw new AppError(409, 'APPLICATION_CLOSED');
      if (!quick) return [];
      // Спершу подія — за PK, без сканування діапазону черги (вставки `logEvent` не чекають).
      // Диспетчер саме її обробляє (FOR UPDATE SKIP LOCKED) → UPDATE чекає на його коміт і
      // не змінює рядок (`dispatched_at` уже є), а створене ним сповіщення видаляється нижче.
      // Ще не взяв → рядок заблоковано нами, диспетчер його пропустить, а після коміту він уже
      // оброблений. Уже обробив → події тут немає, сповіщення видаляється нижче.
      const pendingEvents = await tx
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.type, 'application.created'),
            eq(events.entityType, 'application'),
            eq(events.entityId, id),
            isNull(events.dispatchedAt),
          ),
        );
      for (const ev of pendingEvents) {
        await tx
          .update(events)
          .set({ dispatchedAt: now })
          .where(and(eq(events.id, ev.id), isNull(events.dispatchedAt)));
      }
      const unread = and(
        eq(notifications.userId, row.gmUserId),
        eq(notifications.type, 'application.created'),
        eq(notifications.entityType, 'application'),
        eq(notifications.entityId, id),
        isNull(notifications.readAt),
      );
      const found = await tx
        .select({ id: notifications.id, userId: notifications.userId })
        .from(notifications)
        .where(unread)
        .for('update');
      if (found.length) {
        await tx.delete(notifications).where(
          inArray(
            notifications.id,
            found.map((n) => n.id),
          ),
        );
      }
      return found;
    },
    { isolationLevel: 'read committed' },
  );
  await logEvent(db, {
    type: 'application.withdrawn',
    userId,
    entityType: 'application',
    entityId: id,
    payload: { gameId: row.app.gameId, ...(quick ? { quick: true } : {}) },
  });
  emitNotificationsNew(deps, removed);
  await afterChange(deps, userId, id, row.app.gameId, row.gmUserId);
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
      // Пауза: `pending`-заявки лишаються, майстер вирішує після відновлення (відхилити — можна).
      if (g.status === 'paused') throw new AppError(409, 'GAME_PAUSED');
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
  await afterChange(deps, gmUserId, id, app.gameId, app.userId);
  memberJoined(deps, app.gameId, app.userId);
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
  await afterChange(deps, gmUserId, id, app.gameId, app.userId);
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
  await deps.db.transaction(async (tx) => {
    await tx
      .insert(applicationConstraintResponses)
      .values({ applicationId: id, constraintId: constraintIdParam, ...values })
      .onDuplicateKeyUpdate({ set: values });
    // Відповідь майстра — зміна заявки для автора (стан «оновлено»).
    await tx
      .update(gameApplications)
      .set({ updatedAt: new Date() })
      .where(eq(gameApplications.id, id));
  });
  await afterChange(deps, gmUserId, id, app.gameId, app.userId);
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
  const [loaded, responses, viewer, seen] = await Promise.all([
    loadGames(deps, inArray(games.id, gameIds)),
    responsesOf(
      deps,
      rows.map((r) => r.id),
    ),
    viewerById(deps, userId),
    seenFor(deps, userId, 'application', rows),
  ]);
  const now = new Date();
  const cards = new Map(
    loaded.map((l) => [l.row.id, toCardView(toCardDto(l, now), l.row.gmUserId, viewer, now)]),
  );
  return rows.flatMap((r) => {
    const game = cards.get(r.gameId);
    return game ? [{ ...toDto(r, responses.get(r.id)), game, seen: seen.get(r.id) ?? 'new' }] : [];
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
  const [responses, seen] = await Promise.all([
    responsesOf(
      deps,
      rows.map((r) => r.app.id),
    ),
    seenFor(
      deps,
      gmUserId,
      'application',
      rows.map((r) => r.app),
    ),
  ]);
  const now = new Date();
  return rows.map((r) => ({
    seen: seen.get(r.app.id) ?? ('new' as const),
    ...toDto(r.app, responses.get(r.app.id)),
    applicant: { publicId: r.publicId, nickname: r.nickname, avatarUrl: r.avatarUrl },
    meetsAgeRating: meetsAgeRating(
      viewerAge({ userId: r.app.userId, birthDate: r.birthDate, timezone: r.timezone }, now),
      g.ageRating,
    ),
  }));
}
