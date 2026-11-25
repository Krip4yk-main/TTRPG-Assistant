import { and, asc, desc, eq, inArray, like, ne, or, gt } from 'drizzle-orm';
import {
  adminUsersQuerySchema,
  ownerTransferSchema,
  roleChangeSchema,
  type AdminPageDto,
  type AdminUserDto,
  type AdminUserListItemDto,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import { evictUserSessionCache } from '../auth/session.service.js';
import { sanctions, users } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import { complaintsAboutUser, type StaffViewer } from './complaints.service.js';
import { writeLog } from './log.js';
import { assertCan, assertCanActOn, type Role } from './permissions.js';
import { runAfterCommit, sanctionDto } from './sanctions.service.js';

type Deps = Pick<AppDeps, 'db' | 'redis' | 'env'> & Partial<Pick<AppDeps, 'realtime'>>;

// ---------- пошук і картка ----------

/** `%`, `_` і `\` у LIKE — буквально. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * `GET /api/admin/users?q=&cursor=&limit=` (модератор+): за точним `publicId` або початком ніку
 * (без регістру), без незавершених реєстрацій; за id за зростанням (`cursor` — останній id).
 */
export async function searchUsers(
  deps: Pick<AppDeps, 'db'>,
  viewer: StaffViewer,
  query: unknown,
): Promise<AdminPageDto<AdminUserListItemDto>> {
  assertCan(viewer.role, 'complaints.review');
  const { q, cursor, limit } = adminUsersQuerySchema.parse(query);
  const rows = await deps.db
    .select({
      id: users.id,
      publicId: users.publicId,
      nickname: users.nickname,
      avatarUrl: users.avatarUrl,
      role: users.role,
      status: users.status,
      isBanned: users.isBanned,
    })
    .from(users)
    .where(
      and(
        ne(users.status, 'pending'),
        q ? or(eq(users.publicId, q), like(users.nickname, `${escapeLike(q)}%`)) : undefined,
        cursor !== undefined ? gt(users.id, cursor) : undefined,
      ),
    )
    .orderBy(asc(users.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => ({
      publicId: r.publicId,
      nickname: r.nickname,
      avatarUrl: r.avatarUrl,
      role: r.role,
      status: r.status as AdminUserListItemDto['status'],
      isBanned: r.isBanned,
    })),
    nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}

/**
 * `GET /api/admin/users/:publicId` (модератор+): роль, усі санкції (новіші першими), скарги на
 * людину (видимі ролі переглядача; скаржники — лише для адміна/власника).
 */
export async function adminUserCard(
  deps: Pick<AppDeps, 'db'>,
  viewer: StaffViewer,
  publicId: string,
): Promise<AdminUserDto> {
  assertCan(viewer.role, 'complaints.review');
  const [u] = await deps.db.select().from(users).where(eq(users.publicId, publicId));
  if (!u || u.status === 'pending') throw new AppError(404, 'NOT_FOUND');
  const ids = await deps.db
    .select({ id: sanctions.id })
    .from(sanctions)
    .where(eq(sanctions.userId, u.id))
    .orderBy(desc(sanctions.startsAt), desc(sanctions.id));
  const now = new Date();
  const list = [];
  for (const { id } of ids) list.push(await sanctionDto(deps.db, id, now));
  return {
    publicId: u.publicId,
    nickname: u.nickname,
    avatarUrl: u.avatarUrl,
    role: u.role,
    status: u.status,
    isBanned: u.isBanned,
    createdAt: u.createdAt.toISOString(),
    sanctions: list,
    complaints: await complaintsAboutUser(deps.db, viewer, u.id),
  };
}

// ---------- ролі ----------

/**
 * `PUT /api/admin/users/:publicId/role {role}`. Роль діяча — з БД у транзакції. Матриця:
 * призначити/зняти модератора — адмін+ (`roles.moderator`), адміна — лише власник
 * (`roles.admin`); ціль — лише з нижчою роллю (`assertCanActOn`: себе, рівного чи вищого не
 * можна; власника — лише передачею). Та сама роль — без змін і без журналу. Після коміту —
 * скидання кешу сесій цілі: нова роль діє з наступного запиту.
 */
export async function changeRole(
  deps: Deps,
  actorId: number,
  publicId: string,
  body: unknown,
): Promise<AdminUserDto> {
  const { role: next } = roleChangeSchema.parse(body);
  const [peek] = await deps.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.publicId, publicId));
  if (!peek) throw new AppError(404, 'NOT_FOUND');
  const { targetId, changed } = await deps.db.transaction(async (tx) => {
    // Діяч (S) і ціль (X) — у порядку id: дві зустрічні зміни ролей не зациклюються, а роль
    // діяча не зміниться до коміту.
    const rows = new Map<number, { role: Role; status: string; isBanned: boolean }>();
    for (const id of [...new Set([actorId, peek.id])].sort((a, b) => a - b)) {
      const [row] = await tx
        .select({ role: users.role, status: users.status, isBanned: users.isBanned })
        .from(users)
        .where(eq(users.id, id))
        .for(id === peek.id ? 'update' : 'share');
      if (row) rows.set(id, row);
    }
    const actor = rows.get(actorId);
    if (!actor || actor.status !== 'active' || actor.isBanned) {
      throw new AppError(403, 'MODERATION_FORBIDDEN');
    }
    const role = actor.role;
    // Право хоча б на модераторів — інакше 403 ще до перевірки цілі.
    assertCan(role, 'roles.moderator');
    const found = rows.get(peek.id);
    const t = found && { id: peek.id, ...found };
    if (!t || t.status !== 'active') throw new AppError(404, 'NOT_FOUND');
    assertCanActOn(role, t.role);
    if (next === 'admin' || t.role === 'admin') assertCan(role, 'roles.admin');
    if (t.role === next) return { targetId: t.id, changed: false };
    await tx.update(users).set({ role: next }).where(eq(users.id, t.id));
    await writeLog(tx, {
      actorId,
      action: 'role.change',
      targetType: 'user',
      targetId: t.id,
      meta: { from: t.role, to: next },
    });
    return { targetId: t.id, changed: true };
  });
  if (changed) await runAfterCommit('role', () => evictUserSessionCache(deps, targetId));
  return adminUserCard(deps, { userId: actorId, role: await currentRole(deps, actorId) }, publicId);
}

async function currentRole(deps: Pick<AppDeps, 'db'>, userId: number): Promise<Role> {
  const [u] = await deps.db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  return u?.role ?? 'user';
}

const sameNickname = (a: string, b: string | null) =>
  b !== null && a.trim().toLocaleLowerCase('uk') === b.toLocaleLowerCase('uk');

/**
 * `POST /api/admin/owner/transfer {toPublicId, confirmNickname}` (лише власник, роль — з БД).
 * Ціль — чинний адмін (активний, не забанений), нік підтверджено (без регістру); інакше 400
 * `OWNER_TRANSFER_INVALID` (`details.reason`: `NOT_ADMIN` | `NICKNAME_MISMATCH`). Ціль стає
 * власником, колишній власник — адміном (і далі може видалити акаунт). Обидва рядки — під
 * X-локом у порядку id. Журнал `owner.transfer`; після коміту — скидання кешу сесій обох.
 */
export async function transferOwner(
  deps: Deps,
  actorId: number,
  body: unknown,
): Promise<AdminUserDto> {
  const { toPublicId, confirmNickname } = ownerTransferSchema.parse(body);
  const [peek] = await deps.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.publicId, toPublicId));
  const targetId = await deps.db.transaction(async (tx) => {
    const lockIds = [actorId, ...(peek && peek.id !== actorId ? [peek.id] : [])];
    const locked = await tx
      .select({
        id: users.id,
        role: users.role,
        status: users.status,
        isBanned: users.isBanned,
        nickname: users.nickname,
        publicId: users.publicId,
      })
      .from(users)
      .where(inArray(users.id, lockIds))
      .orderBy(asc(users.id))
      .for('update');
    const actor = locked.find((u) => u.id === actorId);
    if (!actor || actor.status !== 'active' || actor.isBanned) {
      throw new AppError(403, 'MODERATION_FORBIDDEN');
    }
    assertCan(actor.role, 'owner.transfer');
    const t = locked.find((u) => u.id !== actorId && u.publicId === toPublicId);
    if (!t || t.role !== 'admin' || t.status !== 'active' || t.isBanned) {
      throw new AppError(400, 'OWNER_TRANSFER_INVALID', { reason: 'NOT_ADMIN' });
    }
    if (!sameNickname(confirmNickname, t.nickname)) {
      throw new AppError(400, 'OWNER_TRANSFER_INVALID', { reason: 'NICKNAME_MISMATCH' });
    }
    await tx.update(users).set({ role: 'owner' }).where(eq(users.id, t.id));
    await tx.update(users).set({ role: 'admin' }).where(eq(users.id, actorId));
    await writeLog(tx, {
      actorId,
      action: 'owner.transfer',
      targetType: 'user',
      targetId: t.id,
      meta: { fromUserId: actorId },
    });
    return t.id;
  });
  await runAfterCommit('owner-transfer', async () => {
    await evictUserSessionCache(deps, targetId);
    await evictUserSessionCache(deps, actorId);
  });
  return adminUserCard(deps, { userId: actorId, role: 'admin' }, toPublicId);
}
