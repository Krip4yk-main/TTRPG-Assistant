import type { Tx } from '../applications/applications.rules.js';
import type { Db } from '../db/client.js';
import { moderationLog } from '../db/schema/index.js';

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
