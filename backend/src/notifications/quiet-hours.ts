import { dayNumber, fromDayNumber, toZoned, zonedToUtc, type QuietHours } from '@nri/shared';

const HOUR_MS = 3_600_000;
/** Сесія, що починається (стара чи нова дата) не далі ніж за стільки, — термінове. */
export const URGENT_WITHIN_MS = 2 * HOUR_MS;
/** Типи про сесію, що можуть бути терміновими: нагадування, перенесення, скасування. */
const URGENT_TYPES = new Set(['session.reminder', 'session.rescheduled', 'session.cancelled']);
/** Завжди термінові (незалежно від часу сесії): X-Card — сигнал майстру під час гри. */
const ALWAYS_URGENT_TYPES = new Set(['session.x_card']);

/** Типи, що йдуть завжди й зі звуком навіть у тихі години (X-Card — сигнал безпеки). */
export const isAlwaysUrgent = (type: string): boolean => ALWAYS_URGENT_TYPES.has(type);

const DEFAULT_ZONE = 'Europe/Kyiv';

function isKnownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

/**
 * Кінець тихих годин, якщо `now` у них (у поясі `tz`), інакше `null`. Інтервал `[start, end)`;
 * `start > end` — через північ (23:00–08:00: о 23:30 → 08:00 наступного дня, о 07:00 → 08:00
 * того ж). Локальний кінець переводиться в UTC через `zonedToUtc` (DST: неіснуючий час
 * зсувається вперед, подвійний — раніший момент).
 */
export function quietHoursEnd(now: Date, quiet: QuietHours, zone: string): Date | null {
  if (!quiet.enabled) return null;
  // Невідомий пояс у БД не має зривати транзакцію сповіщення — рахуємо за типовим.
  const tz = isKnownZone(zone) ? zone : DEFAULT_ZONE;
  const local = toZoned(now, tz);
  const m = local.hour * 60 + local.minute;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  const inside = start < end ? m >= start && m < end : m >= start || m < end;
  if (!inside) return null;
  // Через північ і ще до півночі — кінець завтра; інакше сьогодні.
  const today = dayNumber(local.year, local.month, local.day);
  const date = fromDayNumber(start > end && m >= start ? today + 1 : today);
  const at = zonedToUtc({ ...date, hour: Math.floor(end / 60), minute: end % 60 }, tz);
  return at.getTime() > now.getTime() ? at : null;
}

/**
 * Термінове: нагадування / перенесення / скасування сесії, що починається (стара `from` або
 * нова `startsAt` дата) не далі ніж за 2 год від `now` (або почалась щойно, ≤ 2 год тому) —
 * чи ще до кінця тихих годин `quietEnd`: відкладене до ранку прийшло б уже після сесії.
 * X-Card (`session.x_card`) — термінова завжди, і зі звуком навіть у тихі години.
 */
export function isUrgent(
  type: string,
  params: { startsAt?: string; from?: string },
  now: Date,
  quietEnd: Date | null = null,
): boolean {
  if (isAlwaysUrgent(type)) return true;
  if (!URGENT_TYPES.has(type)) return false;
  const nowMs = now.getTime();
  const horizon = Math.max(nowMs + URGENT_WITHIN_MS, quietEnd?.getTime() ?? 0);
  return [params.startsAt, params.from].some((iso) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= nowMs - URGENT_WITHIN_MS && t <= horizon;
  });
}
