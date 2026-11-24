import { asc, eq } from 'drizzle-orm';
import type {
  AvailabilityDto,
  AvailabilityUpdate,
  CalendarSettingsDto,
  CalendarSettingsPatch,
  Weekday,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import {
  availabilityBusyDates,
  availabilitySlots,
  userSettings,
  users,
} from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import { AppError } from '../http/errors.js';

export async function getAvailability(deps: AppDeps, userId: number): Promise<AvailabilityDto> {
  const { db } = deps;
  const [u] = await db.select({ tz: users.timezone }).from(users).where(eq(users.id, userId));
  if (!u) throw new AppError(401, 'UNAUTHENTICATED');
  const [slots, busy] = await Promise.all([
    db
      .select()
      .from(availabilitySlots)
      .where(eq(availabilitySlots.userId, userId))
      .orderBy(asc(availabilitySlots.weekday), asc(availabilitySlots.startMin)),
    db
      .select()
      .from(availabilityBusyDates)
      .where(eq(availabilityBusyDates.userId, userId))
      .orderBy(asc(availabilityBusyDates.date)),
  ]);
  return {
    timezone: u.tz,
    slots: slots.map((s) => ({
      weekday: s.weekday as Weekday,
      startMin: s.startMin,
      endMin: s.endMin,
    })),
    busyDates: busy.map((b) => b.date),
  };
}

/**
 * Атомарно замінює весь календар. Пояс — завжди пояс акаунта (`users.timezone`): календар
 * його не змінює (R5), це робить лише `PATCH /api/me/timezone`.
 */
export async function replaceAvailability(
  deps: AppDeps,
  userId: number,
  input: AvailabilityUpdate,
): Promise<AvailabilityDto> {
  const { db } = deps;
  await db.transaction(async (tx) => {
    await tx.delete(availabilitySlots).where(eq(availabilitySlots.userId, userId));
    await tx.delete(availabilityBusyDates).where(eq(availabilityBusyDates.userId, userId));
    if (input.slots.length) {
      await tx.insert(availabilitySlots).values(input.slots.map((s) => ({ userId, ...s })));
    }
    if (input.busyDates.length) {
      await tx
        .insert(availabilityBusyDates)
        .values(input.busyDates.map((date) => ({ userId, date })));
    }
  });
  await logEvent(db, {
    type: 'availability.updated',
    userId,
    entityType: 'user',
    entityId: userId,
    payload: { slots: input.slots.length, busyDates: input.busyDates.length },
  });
  return getAvailability(deps, userId);
}

// ---------- налаштування календаря ----------

/** Налаштування користувача; рядка може не бути — тоді діють значення за замовчуванням. */
export async function getCalendarSettings(
  deps: AppDeps,
  userId: number,
): Promise<CalendarSettingsDto> {
  const [row] = await deps.db
    .select({ calendarAutoBusy: userSettings.calendarAutoBusy })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  return { calendarAutoBusy: row?.calendarAutoBusy ?? true };
}

export async function updateCalendarSettings(
  deps: AppDeps,
  userId: number,
  patch: CalendarSettingsPatch,
): Promise<CalendarSettingsDto> {
  await deps.db
    .insert(userSettings)
    .values({ userId, calendarAutoBusy: patch.calendarAutoBusy })
    .onDuplicateKeyUpdate({ set: { calendarAutoBusy: patch.calendarAutoBusy } });
  return getCalendarSettings(deps, userId);
}
