import { localDate, START_WINDOW_MAX, START_WINDOW_MIN, START_WINDOW_STEP } from '@nri/shared';
import { formatTime, zonedInputToUtc } from '../../../core/i18n/dates';

const pad = (n: number) => String(n).padStart(2, '0');
const DAY_MIN = 24 * 60;
const MINUTE_MS = 60_000;

/** Старти вікна «з»: 00:00 … 23:30 з кроком 30 хв. */
export const WINDOW_START_TIMES: readonly string[] = Array.from(
  { length: DAY_MIN / START_WINDOW_STEP },
  (_, i) => `${pad(Math.floor((i * START_WINDOW_STEP) / 60))}:${pad((i * START_WINDOW_STEP) % 60)}`,
);

/** Ширини вікна: 30 хв … 12 год з кроком 30 хв (як у схемі). */
export const WINDOW_LENGTHS: readonly number[] = Array.from(
  { length: (START_WINDOW_MAX - START_WINDOW_MIN) / START_WINDOW_STEP + 1 },
  (_, i) => START_WINDOW_MIN + i * START_WINDOW_STEP,
);

/** Ширина вікна, коли майстер щойно перемкнув на «Приблизно». */
export const DEFAULT_WINDOW_MINUTES = 180;

/** «З» за замовчуванням, коли майстер перемкнув на «Приблизно», а часу ще не було. */
export const DEFAULT_WINDOW_START = '18:00';

/** `HH:mm` → вниз до кроку 30 хв (`19:15` → `19:00`); некоректне — `null`. */
export function snapToWindowStep(time: string): string | null {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const total = Number(m[1]) * 60 + Number(m[2]);
  const snapped = total - (total % START_WINDOW_STEP);
  return `${pad(Math.floor(snapped / 60))}:${pad(snapped % 60)}`;
}

/** Варіант «до»: ширина вікна, час кінця (`null` — початок ще не задано) і чи це наступний день. */
export interface WindowEndOption {
  minutes: number;
  time: string | null;
  nextDay: boolean;
}

/**
 * Варіанти «до» для старту `time` дати `date` у поясі `timeZone`. Із датою кінець рахується
 * в UTC-мілісекундах (як на сервері): у день переходу на літній час підпис показує справжній
 * місцевий час кінця. Без дати — за годинником (`time` + ширина).
 */
export function windowEndOptions(
  date: Date | null,
  time: string,
  timeZone: string,
): WindowEndOption[] {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  const startIso = m ? zonedInputToUtc(date, time, timeZone) : null;
  return WINDOW_LENGTHS.map((minutes) => {
    if (!m) return { minutes, time: null, nextDay: false };
    if (startIso) {
      const start = new Date(startIso);
      const end = new Date(start.getTime() + minutes * MINUTE_MS);
      return {
        minutes,
        time: formatTime(end.toISOString(), timeZone),
        nextDay: localDate(end, timeZone) !== localDate(start, timeZone),
      };
    }
    const total = Number(m[1]) * 60 + Number(m[2]) + minutes;
    return {
      minutes,
      time: `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`,
      nextDay: total >= DAY_MIN,
    };
  });
}
