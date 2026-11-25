import type { EventType } from '@nri/shared';
import type { Db } from '../db/client.js';
import { events } from '../db/schema/index.js';

export interface LogEventInput {
  /** Лише відомі типи (`EVENT_TYPES` у `@nri/shared`). */
  type: EventType;
  /** `null` — без автора (система, адміністрація). */
  userId?: number | null;
  entityType?: string;
  entityId?: number;
  payload?: unknown;
}

/** Пише подію в журнал; ніколи не кидає — помилку лише логуємо. */
export async function logEvent(db: Db, e: LogEventInput): Promise<void> {
  try {
    await db.insert(events).values({
      type: e.type,
      userId: e.userId ?? null,
      entityType: e.entityType ?? null,
      entityId: e.entityId ?? null,
      payload: e.payload ?? null,
    });
  } catch (err) {
    console.error('logEvent failed', err);
  }
}
