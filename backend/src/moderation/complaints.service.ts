import { and, count, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import {
  complaintActionSchema,
  complaintDismissSchema,
  complaintInputSchema,
  complaintsQuerySchema,
  type AdminPageDto,
  type ComplaintCreatedDto,
  type ComplaintDto,
  type ComplaintStatus,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { Tx } from '../applications/applications.rules.js';
import type { Db } from '../db/client.js';
import { complaints, games, users } from '../db/schema/index.js';
import { isHiddenFromNonGm } from '../games/games.visibility.js';
import { AppError } from '../http/errors.js';
import {
  createNotification,
  emitNotificationsNew,
  type NotificationRow,
} from '../notifications/notifications.service.js';
import { writeLog } from './log.js';
import { assertCan, ROLE_RANK, type Role } from './permissions.js';
import { imposeSanctionTx } from './sanctions.service.js';
import { leaveCandidates } from '../users/leave-cascade.js';

type DbLike = Db | Tx;
/** Хто дивиться/діє: id і роль із сесії. */
export type StaffViewer = { userId: number; role: Role };

const ROLES = Object.keys(ROLE_RANK) as Role[];

// ---------- подання ----------

/**
 * Чи `reporterId` перетинався з `targetId`: спільна гра (обидва учасники, будь-коли, зокрема
 * колишні), майстер ↔ учасник (зокрема колишній), ціль подавала заявку на гру `reporterId`, або
 * `reporterId` подавав заявку на гру цілі (будь-який статус заявки).
 */
export async function haveCrossedPaths(
  db: DbLike,
  reporterId: number,
  targetId: number,
): Promise<boolean> {
  const r = reporterId;
  const t = targetId;
  const [rows] = (await db.execute(sql`
    SELECT 1 AS ok FROM DUAL WHERE
      EXISTS (
        SELECT 1 FROM game_members a JOIN game_members b ON b.game_id = a.game_id
        WHERE a.user_id = ${r} AND b.user_id = ${t}
      )
      OR EXISTS (
        SELECT 1 FROM games g JOIN game_members m ON m.game_id = g.id
        WHERE (g.gm_user_id = ${r} AND m.user_id = ${t}) OR (g.gm_user_id = ${t} AND m.user_id = ${r})
      )
      OR EXISTS (
        SELECT 1 FROM game_applications ap JOIN games g ON g.id = ap.game_id
        WHERE (ap.user_id = ${t} AND g.gm_user_id = ${r}) OR (ap.user_id = ${r} AND g.gm_user_id = ${t})
      )
  `)) as unknown as [{ ok: number }[]];
  return rows.length > 0;
}

/**
 * `POST /api/complaints`. На людину — лише за `haveCrossedPaths`; на гру — будь-хто, кому гра
 * видима (неопублікована чужа → 404), крім її майстра. На себе / свою гру / без перетину —
 * 403 `COMPLAINT_NOT_ALLOWED`; невідома, видалена чи незавершена реєстрація цілі → 404.
 */
export async function submitComplaint(
  deps: Pick<AppDeps, 'db'>,
  reporterId: number,
  body: unknown,
): Promise<ComplaintCreatedDto> {
  const input = complaintInputSchema.parse(body);
  let targetUserId: number | null = null;
  let targetGameId: number | null = null;
  if (input.targetUserId !== undefined) {
    const [t] = await deps.db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.publicId, input.targetUserId));
    if (!t || t.status !== 'active') throw new AppError(404, 'NOT_FOUND');
    if (t.id === reporterId) throw new AppError(403, 'COMPLAINT_NOT_ALLOWED');
    if (!(await haveCrossedPaths(deps.db, reporterId, t.id))) {
      throw new AppError(403, 'COMPLAINT_NOT_ALLOWED');
    }
    targetUserId = t.id;
  } else {
    const [g] = await deps.db
      .select({
        id: games.id,
        gmUserId: games.gmUserId,
        status: games.status,
        publishedAt: games.publishedAt,
      })
      .from(games)
      .where(eq(games.id, input.targetGameId!));
    if (!g) throw new AppError(404, 'NOT_FOUND');
    if (g.gmUserId === reporterId) throw new AppError(403, 'COMPLAINT_NOT_ALLOWED');
    if (isHiddenFromNonGm(g)) throw new AppError(404, 'NOT_FOUND');
    targetGameId = g.id;
  }
  const [res] = await deps.db
    .insert(complaints)
    .values({
      reporterId,
      targetUserId,
      targetGameId,
      reason: input.reason,
      message: input.message,
    })
    .$returningId();
  return { id: res!.id };
}

// ---------- видимість для персоналу ----------

/**
 * Ролі цілей, скарги на яких бачить роль `viewer`: модератор — на користувачів; адмін — ще й на
 * модераторів; власник — на всіх (зокрема на адмінів і на себе). Для скарги на гру роль цілі —
 * роль її майстра (модератор не бачить скарг на гру модератора, зокрема на власну, чи адміна).
 */
export function visibleTargetRoles(viewer: Role): Role[] {
  if (viewer === 'owner') return ROLES;
  return ROLES.filter((r) => ROLE_RANK[r] < ROLE_RANK[viewer]);
}

/** `targetRole` — роль людини-цілі або майстра гри-цілі. */
export function complaintVisibleTo(viewer: Role, targetRole: Role): boolean {
  return visibleTargetRoles(viewer).includes(targetRole);
}

const reporterU = alias(users, 'complaint_reporter');
const targetU = alias(users, 'complaint_target');
const resolverU = alias(users, 'complaint_resolver');
const gameGmU = alias(users, 'complaint_game_gm');

/** Роль цілі скарги: людини або майстра гри (запит має приєднати `targetU`, `games`, `gameGmU`). */
const subjectRole = sql`COALESCE(${targetU.role}, ${gameGmU.role})`;

/** Умова видимості скарги для ролі (запит має приєднати `targetU`, `games`, `gameGmU`). */
function visibleWhere(viewer: Role): SQL {
  const roles = visibleTargetRoles(viewer);
  return roles.length ? inArray(subjectRole, roles) : sql`FALSE`;
}

function baseQuery(db: DbLike) {
  return db
    .select({
      c: complaints,
      reporter: {
        publicId: reporterU.publicId,
        nickname: reporterU.nickname,
        role: reporterU.role,
      },
      target: { publicId: targetU.publicId, nickname: targetU.nickname, role: targetU.role },
      resolver: {
        publicId: resolverU.publicId,
        nickname: resolverU.nickname,
        role: resolverU.role,
      },
      game: { id: games.id, title: games.title },
      gameGmId: games.gmUserId,
    })
    .from(complaints)
    .innerJoin(reporterU, eq(reporterU.id, complaints.reporterId))
    .leftJoin(targetU, eq(targetU.id, complaints.targetUserId))
    .leftJoin(resolverU, eq(resolverU.id, complaints.resolvedBy))
    .leftJoin(games, eq(games.id, complaints.targetGameId))
    .leftJoin(gameGmU, eq(gameGmU.id, games.gmUserId));
}

type Row = Awaited<ReturnType<ReturnType<typeof baseQuery>['execute']>>[number];

/**
 * Чи переглядач — сам суб'єкт скарги (людина-ціль або майстер гри-цілі; буває лише у власника):
 * тоді скаржника не показуємо — анонімність діє й для персоналу, на якого скаржились.
 */
function isSubject(r: Row, viewerId: number): boolean {
  return r.c.targetUserId === viewerId || (r.c.targetGameId !== null && r.gameGmId === viewerId);
}

/**
 * Скарга для персоналу; `showReporter: false` — без скаржника (картка цілі для модератора, Task
 * 4). Ціль ніколи не отримує ці дані: усі маршрути — лише для персоналу.
 */
export function toComplaintDto(r: Row, opts: { showReporter: boolean }): ComplaintDto {
  const c = r.c;
  return {
    id: c.id,
    reporter: opts.showReporter ? r.reporter : null,
    targetUser: c.targetUserId !== null && r.target ? r.target : null,
    targetGame: c.targetGameId !== null && r.game ? r.game : null,
    reason: c.reason,
    message: c.message,
    status: c.status,
    resolvedBy: c.resolvedBy !== null && r.resolver ? r.resolver : null,
    resolvedAt: c.resolvedAt ? c.resolvedAt.toISOString() : null,
    sanctionId: c.sanctionId,
    createdAt: c.createdAt.toISOString(),
  };
}

/** `GET /api/admin/complaints?status=&cursor=&limit=` — новіші першими, лише видимі ролі. */
export async function listComplaints(
  deps: Pick<AppDeps, 'db'>,
  viewer: StaffViewer,
  query: unknown,
): Promise<AdminPageDto<ComplaintDto>> {
  assertCan(viewer.role, 'complaints.review');
  const { status, cursor, limit } = complaintsQuerySchema.parse(query);
  const rows = await baseQuery(deps.db)
    .where(
      and(
        visibleWhere(viewer.role),
        status ? eq(complaints.status, status) : undefined,
        cursor !== undefined ? lt(complaints.id, cursor) : undefined,
      ),
    )
    .orderBy(desc(complaints.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => toComplaintDto(r, { showReporter: !isSubject(r, viewer.userId) })),
    nextCursor: rows.length > limit ? page[page.length - 1]!.c.id : null,
  };
}

/** Кількість скарг зі статусом `status`, видимих ролі `viewer` (щоденне зведення). */
export async function countVisibleComplaints(
  db: DbLike,
  viewer: Role,
  status: ComplaintStatus = 'new',
): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(complaints)
    .leftJoin(targetU, eq(targetU.id, complaints.targetUserId))
    .leftJoin(games, eq(games.id, complaints.targetGameId))
    .leftJoin(gameGmU, eq(gameGmU.id, games.gmUserId))
    .where(and(eq(complaints.status, status), visibleWhere(viewer)));
  return r?.n ?? 0;
}

// ---------- рішення ----------

/** Скарга під блокуванням; невидима для ролі чи відсутня → 404; вже розглянута → 409. */
async function lockNew(tx: Tx, viewer: StaffViewer, id: number) {
  const [c] = await tx
    .select({
      id: complaints.id,
      status: complaints.status,
      reporterId: complaints.reporterId,
      targetUserId: complaints.targetUserId,
      targetGameId: complaints.targetGameId,
    })
    .from(complaints)
    .where(eq(complaints.id, id))
    .for('update');
  if (!c) throw new AppError(404, 'NOT_FOUND');
  // Роль цілі: людини або майстра гри-цілі.
  let subjectId = c.targetUserId;
  if (subjectId === null) {
    const [g] = await tx
      .select({ gmUserId: games.gmUserId })
      .from(games)
      .where(eq(games.id, c.targetGameId!));
    subjectId = g?.gmUserId ?? null;
  }
  let targetRole: Role = 'user';
  if (subjectId !== null) {
    const [t] = await tx.select({ role: users.role }).from(users).where(eq(users.id, subjectId));
    targetRole = t?.role ?? 'user';
  }
  if (!complaintVisibleTo(viewer.role, targetRole)) throw new AppError(404, 'NOT_FOUND');
  if (c.status !== 'new') throw new AppError(409, 'COMPLAINT_RESOLVED');
  return c;
}

/** «Скаргу розглянуто» скаржнику — без цілі, рішення й санкції (анонімність і стислість). */
async function notifyReporter(
  deps: Pick<AppDeps, 'env'>,
  tx: Tx,
  reporterId: number,
  complaintId: number,
): Promise<NotificationRow | null> {
  const [u] = await tx.select({ status: users.status }).from(users).where(eq(users.id, reporterId));
  if (u?.status !== 'active') return null;
  return createNotification(deps, tx, {
    userId: reporterId,
    type: 'complaint.resolved',
    category: 'moderation',
    params: {},
    entityType: 'complaint',
    entityId: complaintId,
  });
}

async function complaintDto(db: DbLike, id: number, viewer: StaffViewer): Promise<ComplaintDto> {
  const [r] = await baseQuery(db).where(eq(complaints.id, id));
  return toComplaintDto(r!, { showReporter: !isSubject(r!, viewer.userId) });
}

/** `POST /api/admin/complaints/:id/dismiss {note?}`: відхилити; журнал; скаржнику — сповіщення. */
export async function dismissComplaint(
  deps: AppDeps,
  viewer: StaffViewer,
  id: number,
  body: unknown,
): Promise<ComplaintDto> {
  assertCan(viewer.role, 'complaints.review');
  const { note } = complaintDismissSchema.parse(body);
  const { dto, row } = await deps.db.transaction(async (tx) => {
    const c = await lockNew(tx, viewer, id);
    await tx
      .update(complaints)
      .set({ status: 'dismissed', resolvedBy: viewer.userId, resolvedAt: new Date() })
      .where(eq(complaints.id, id));
    await writeLog(tx, {
      actorId: viewer.userId,
      action: 'complaint.dismiss',
      targetType: 'complaint',
      targetId: id,
      reason: note ?? null,
    });
    const row = await notifyReporter(deps, tx, c.reporterId, id);
    return { dto: await complaintDto(tx, id, viewer), row };
  });
  if (row) emitNotificationsNew(deps, [row]);
  return dto;
}

/** Кандидати каскаду бану для цілі скарги `id` (звичайне читання поза транзакцією). */
async function banCandidates(db: Db, id: number): Promise<number[] | undefined> {
  const [c] = await db
    .select({ targetUserId: complaints.targetUserId, gmUserId: games.gmUserId })
    .from(complaints)
    .leftJoin(games, eq(games.id, complaints.targetGameId))
    .where(eq(complaints.id, id));
  const userId = c?.targetUserId ?? c?.gmUserId ?? null;
  return userId === null ? undefined : leaveCandidates(db, userId);
}

/**
 * `POST /api/admin/complaints/:id/action {sanction}`: санкція (`imposeSanction`) людині-цілі або
 * майстру гри-цілі, статус `actioned` з посиланням на санкцію, журнал, сповіщення скаржнику. Усе
 * в одній транзакції: відмова в праві на санкцію (напр. модератор → `global_ban`, власник →
 * скарга на себе) лишає скаргу новою.
 */
export async function actionComplaint(
  deps: AppDeps,
  viewer: StaffViewer,
  id: number,
  body: unknown,
): Promise<ComplaintDto> {
  assertCan(viewer.role, 'complaints.review');
  const { sanction } = complaintActionSchema.parse(body);
  // Бан: ігри для блокування — до транзакції (див. `leave-cascade.ts`); ціль скарги незмінна.
  const candidates = sanction.type === 'global_ban' ? await banCandidates(deps.db, id) : undefined;
  const { dto, row, afterCommit } = await deps.db.transaction(async (tx) => {
    const c = await lockNew(tx, viewer, id);
    let userId = c.targetUserId;
    if (userId === null) {
      const [g] = await tx
        .select({ gmUserId: games.gmUserId })
        .from(games)
        .where(eq(games.id, c.targetGameId!));
      userId = g!.gmUserId;
    }
    const { dto: s, afterCommit } = await imposeSanctionTx(
      deps,
      tx,
      viewer.userId,
      userId,
      sanction,
      id,
      candidates,
    );
    await tx
      .update(complaints)
      .set({
        status: 'actioned',
        resolvedBy: viewer.userId,
        resolvedAt: new Date(),
        sanctionId: s.id,
      })
      .where(eq(complaints.id, id));
    await writeLog(tx, {
      actorId: viewer.userId,
      action: 'complaint.action',
      targetType: 'complaint',
      targetId: id,
      reason: null,
      meta: { sanctionId: s.id },
    });
    const row = await notifyReporter(deps, tx, c.reporterId, id);
    return { dto: await complaintDto(tx, id, viewer), row, afterCommit };
  });
  // Побічні ефекти санкції (сесії, каскад, пінги) — лише після коміту скарги.
  await afterCommit();
  if (row) emitNotificationsNew(deps, [row]);
  return dto;
}

/**
 * Скарги на людину (на неї саму й на її ігри як майстра) для картки користувача, новіші першими;
 * лише видимі ролі переглядача. Скаржник — лише для адміна/власника (і не тоді, коли переглядач
 * сам суб'єкт скарги); модератор бачить скарги без скаржників.
 */
export async function complaintsAboutUser(
  db: DbLike,
  viewer: StaffViewer,
  userId: number,
  limit = 100,
): Promise<ComplaintDto[]> {
  const rows = await baseQuery(db)
    .where(
      and(
        visibleWhere(viewer.role),
        sql`(${complaints.targetUserId} = ${userId} OR ${games.gmUserId} = ${userId})`,
      ),
    )
    .orderBy(desc(complaints.id))
    .limit(limit);
  const seeReporters = ROLE_RANK[viewer.role] >= ROLE_RANK.admin;
  return rows.map((r) =>
    toComplaintDto(r, { showReporter: seeReporters && !isSubject(r, viewer.userId) }),
  );
}
