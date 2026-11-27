import {
  dayNumber,
  fromDayNumber,
  normalizeSlots,
  toZoned,
  zonedToUtc,
  type AvailabilityDto,
  type GameBusyDto,
  type Weekday,
} from '@nri/shared';

export type Slot = AvailabilityDto['slots'][number];

export const DAYS = 7;
/** Клітинок на добу (по 30 хв). */
export const CELLS_PER_DAY = 48;
export const CELL_MINUTES = 30;

/** Індекс клітинки в плоскому масиві `DAYS × CELLS_PER_DAY`. */
export const cellIndex = (day: number, cell: number): number => day * CELLS_PER_DAY + cell;

/** Хвилини від півночі → `HH:MM` (1440 → `24:00`). */
export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Слоти → прапорці клітинок (`true` — вільний час). */
export function slotsToCells(slots: readonly Slot[]): boolean[] {
  const cells = new Array<boolean>(DAYS * CELLS_PER_DAY).fill(false);
  for (const s of slots) {
    const from = Math.max(0, Math.floor(s.startMin / CELL_MINUTES));
    const to = Math.min(CELLS_PER_DAY, Math.ceil(s.endMin / CELL_MINUTES));
    for (let c = from; c < to; c++) cells[cellIndex(s.weekday, c)] = true;
  }
  return cells;
}

/** Прапорці клітинок → відсортовані слоти, суміжні клітинки злиті в один інтервал. */
export function cellsToSlots(cells: readonly boolean[]): Slot[] {
  const slots: Slot[] = [];
  for (let d = 0; d < DAYS; d++) {
    let start = -1;
    for (let c = 0; c <= CELLS_PER_DAY; c++) {
      const on = c < CELLS_PER_DAY && cells[cellIndex(d, c)];
      if (on && start < 0) start = c;
      if (!on && start >= 0) {
        slots.push({
          weekday: d as Weekday,
          startMin: start * CELL_MINUTES,
          endMin: c * CELL_MINUTES,
        });
        start = -1;
      }
    }
  }
  return normalizeSlots(slots);
}

/** Скільки днів зайнятості від ігор накладається на тижневу сітку. */
export const GAME_BUSY_DAYS = 7;

/**
 * Вікно зайнятості від ігор: від початку сьогоднішньої доби в поясі `tz` на 7 діб уперед —
 * кожен день тижня сітки відповідає рівно одній даті.
 */
export function gameBusyWindow(now: Date, tz: string): { from: Date; to: Date } {
  const z = toZoned(now, tz);
  const start = dayNumber(z.year, z.month, z.day);
  const midnight = (n: number) => zonedToUtc({ ...fromDayNumber(n), hour: 0, minute: 0 }, tz);
  return { from: midnight(start), to: midnight(start + GAME_BUSY_DAYS) };
}

/**
 * Сесії → підписи в кожній клітинці сітки в поясі `tz`: «Назва, 27.11, 19:00–23:00».
 * Клітинка — за локальною хвилиною доби (пояси зі зсувом :45 теж). Сесії, що вже
 * закінчились до `now`, пропускаються.
 */
export function gameBusyCells(
  busy: readonly GameBusyDto[],
  tz: string,
  now = Date.now(),
): string[][] {
  const out = Array.from({ length: DAYS * CELLS_PER_DAY }, () => [] as string[]);
  for (const b of busy) {
    const end = Date.parse(b.end);
    let t = Date.parse(b.start);
    if (!(end > t) || end <= now) continue;
    const from = toZoned(new Date(t), tz);
    const to = toZoned(new Date(end), tz);
    const pad = (n: number) => String(n).padStart(2, '0');
    const label =
      `${b.gameTitle}, ${pad(from.day)}.${pad(from.month)}, ` +
      `${formatMinutes(from.hour * 60 + from.minute)}–${formatMinutes(to.hour * 60 + to.minute)}`;
    while (t < end) {
      const z = toZoned(new Date(t), tz);
      const minute = z.hour * 60 + z.minute;
      const cell = Math.floor(minute / CELL_MINUTES);
      const labels = out[cellIndex(z.weekday, cell)]!;
      if (!labels.includes(label)) labels.push(label);
      // До наступної межі півгодини за місцевим часом.
      t += ((cell + 1) * CELL_MINUTES - minute) * 60_000 - (t % 60_000);
    }
  }
  return out;
}

/** Шаблон тижня: дні (0 = пн) і проміжок у хвилинах доби — у поясі сітки. */
export interface WeekTemplate {
  days: readonly number[];
  startMin: number;
  endMin: number;
}

/** «Будні вечори 18–22»: пн–пт 18:00–22:00. */
export const WEEKDAY_EVENINGS: WeekTemplate = {
  days: [0, 1, 2, 3, 4],
  startMin: 1080,
  endMin: 1320,
};
/** «Вихідні 12–22»: сб–нд 12:00–22:00. */
export const WEEKENDS: WeekTemplate = { days: [5, 6], startMin: 720, endMin: 1320 };

/** Об'єднання клітинок із шаблоном: позначене лишається позначеним, шаблон додається. */
export function withTemplate(cells: readonly boolean[], t: WeekTemplate): boolean[] {
  const add = slotsToCells(
    t.days.map((d) => ({ weekday: d as Weekday, startMin: t.startMin, endMin: t.endMin })),
  );
  return cells.map((on, i) => on || add[i]!);
}
