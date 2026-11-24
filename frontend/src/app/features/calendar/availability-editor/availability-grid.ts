import { normalizeSlots, type AvailabilityDto, type Weekday } from '@nri/shared';

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
