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

/** Інтервали сесій → назви ігор у кожній клітинці сітки (у поясі `tz`). */
export function gameBusyCells(busy: readonly GameBusyDto[], tz: string): string[][] {
  const out = Array.from({ length: DAYS * CELLS_PER_DAY }, () => [] as string[]);
  const step = CELL_MINUTES * 60_000;
  for (const b of busy) {
    const end = Date.parse(b.end);
    for (let t = Math.floor(Date.parse(b.start) / step) * step; t < end; t += step) {
      const z = toZoned(new Date(t), tz);
      const cell = Math.floor((z.hour * 60 + z.minute) / CELL_MINUTES);
      const titles = out[cellIndex(z.weekday, cell)]!;
      if (!titles.includes(b.gameTitle)) titles.push(b.gameTitle);
    }
  }
  return out;
}
