import { and, eq, inArray } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import { isDuplicateKey, isTransientDbError } from '../db/errors.js';
import { moderationDigestLog, users } from '../db/schema/index.js';
import {
  createNotification,
  emitNotificationsNew,
  type NotificationRow,
} from '../notifications/notifications.service.js';
import { countVisibleComplaints } from './complaints.service.js';
import type { Role } from './permissions.js';

export const DIGEST_JOB = 'moderation.digest';
/**
 * Щогодинна задача (слоти вирівняні за епохою — рівно на початку кожної години UTC). Зведення
 * надсилається лише в слоті, що припадає на 09:00 Europe/Kyiv: 07:00Z узимку (UTC+2), 06:00Z
 * улітку (UTC+3) — літній час враховує `Intl` без власних таблиць переходів.
 */
export const DIGEST_EVERY_MS = 3_600_000;
export const DIGEST_TIME_ZONE = 'Europe/Kyiv';
export const DIGEST_LOCAL_HOUR = 9;

const STAFF_ROLES: Role[] = ['moderator', 'admin', 'owner'];

const kyivFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: DIGEST_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Київська дата (`YYYY-MM-DD`) і година (0–23) моменту `t`. */
export function kyivLocal(t: Date): { date: string; hour: number } {
  const parts = Object.fromEntries(kyivFmt.formatToParts(t).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** Чи `runAt` — слот зведення: рівно початок години, і за Києвом це 09:00. */
export function isDigestSlot(runAt: Date): boolean {
  return runAt.getTime() % DIGEST_EVERY_MS === 0 && kyivLocal(runAt).hour === DIGEST_LOCAL_HOUR;
}

/**
 * Щоденне зведення скарг для задачі, запланованої на `runAt` (поза слотом 09:00 за Києвом —
 * нічого): кожному активному незабаненому модератору/адміну/власнику — одне `moderation.digest`
 * з кількістю нових скарг, які він бачить (`countVisibleComplaints`); 0 — без сповіщення.
 *
 * Дедуплікація — `moderation_digest_log` UNIQUE(user, київська дата): повторний чи паралельний
 * прогін того самого дня не дублює. Кожен отримувач — окрема транзакція; тимчасова помилка БД
 * прокидається (задача повторить, уже надіслані пропустяться), інша — логується.
 */
export async function sendModerationDigest(deps: AppDeps, runAt: Date): Promise<NotificationRow[]> {
  if (!isDigestSlot(runAt)) return [];
  const { date } = kyivLocal(runAt);
  const staff = await deps.db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(
      and(inArray(users.role, STAFF_ROLES), eq(users.status, 'active'), eq(users.isBanned, false)),
    )
    .orderBy(users.id);
  if (staff.length === 0) return [];

  // Кількість залежить лише від ролі — рахуємо раз на роль.
  const byRole = new Map<Role, number>();
  for (const role of new Set(staff.map((s) => s.role))) {
    byRole.set(role, await countVisibleComplaints(deps.db, role));
  }

  const created: NotificationRow[] = [];
  for (const s of staff) {
    const n = byRole.get(s.role) ?? 0;
    if (n === 0) continue;
    try {
      const row = await deps.db.transaction(async (tx) => {
        try {
          await tx.insert(moderationDigestLog).values({ userId: s.id, digestDate: date });
        } catch (err) {
          if (isDuplicateKey(err)) return null; // уже надіслано цього дня
          throw err;
        }
        return createNotification(deps, tx, {
          userId: s.id,
          type: 'moderation.digest',
          category: 'moderation',
          params: { count: n },
          entityType: null,
          entityId: null,
        });
      });
      if (row) {
        emitNotificationsNew(deps, [row]);
        created.push(row);
      }
    } catch (err) {
      if (isTransientDbError(err)) throw err;
      console.error(`moderation digest: user ${s.id} failed`, err);
    }
  }
  return created;
}
