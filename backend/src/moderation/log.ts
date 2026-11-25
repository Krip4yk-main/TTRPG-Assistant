import { and, desc, eq, lt } from 'drizzle-orm';
import { moderationLogQuerySchema, type AdminPageDto, type ModerationLogDto } from '@nri/shared';
import type { Tx } from '../applications/applications.rules.js';
import type { Db } from '../db/client.js';
import { moderationLog } from '../db/schema/index.js';
import { assertCan, type Role } from './permissions.js';
import { refsOf } from './sanctions.service.js';

/** Цілі записів журналу. */
export type LogTargetType = 'user' | 'complaint' | 'sanction' | 'appeal' | 'rating' | 'game';

export interface LogEntry {
  /** `null` — система (задача строків тощо). */
  actorId: number | null;
  action: string;
  targetType: LogTargetType;
  targetId: number;
  reason?: string | null;
  meta?: Record<string, unknown> | null;
}

/** Рядок журналу дій адміністрації (лише додавання) — у транзакції самої дії. */
export async function writeLog(db: Db | Tx, e: LogEntry): Promise<void> {
  await db.insert(moderationLog).values({
    actorId: e.actorId,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId,
    reason: e.reason ?? null,
    meta: e.meta ?? null,
  });
}

/**
 * `GET /api/admin/log?cursor=&limit=&targetType=&targetId=` (адмін+): журнал, новіші першими;
 * необов'язково — лише записи однієї цілі.
 */
export async function listLog(
  db: Db,
  viewerRole: Role,
  query: unknown,
): Promise<AdminPageDto<ModerationLogDto>> {
  assertCan(viewerRole, 'log.view');
  const { cursor, limit, targetType, targetId } = moderationLogQuerySchema.parse(query);
  const rows = await db
    .select()
    .from(moderationLog)
    .where(
      and(
        cursor !== undefined ? lt(moderationLog.id, cursor) : undefined,
        targetType !== undefined ? eq(moderationLog.targetType, targetType) : undefined,
        targetId !== undefined ? eq(moderationLog.targetId, targetId) : undefined,
      ),
    )
    .orderBy(desc(moderationLog.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const refs = await refsOf(
    db,
    page.flatMap((r) => [r.actorId, r.targetType === 'user' ? r.targetId : null]),
  );
  return {
    items: page.map((r) => ({
      id: r.id,
      actor: r.actorId === null ? null : (refs.get(r.actorId) ?? null),
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      targetUser: r.targetType === 'user' ? (refs.get(r.targetId) ?? null) : null,
      reason: r.reason,
      meta: r.meta ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}
