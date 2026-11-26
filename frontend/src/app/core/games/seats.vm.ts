import type { ViewMode } from '../view-mode/view-mode.store';

/**
 * Місця гри для слотів: текст і заповнення індикатора поруч (діоди, кубики, флакони, манометр…)
 * за одним значенням. Гравець бачить зайняті місця («n з m зайняті»: порожньо — ніхто, повно —
 * усі), майстер — вільні («n з m вільні»: повно — усі вільні). Дизайн лише малює `count` з
 * `max` (перші `count` позначок «заповнені») або `fill`, без власної логіки.
 */
export interface SeatsVm {
  mode: 'taken' | 'free';
  /** Число в тексті й кількість заповнених позначок: зайняті (гравцю) або вільні (майстру). */
  count: number;
  max: number;
  /** `count / max`, 0..1 (0 — і коли місць немає). */
  fill: number;
  /** Ключ i18n тексту з параметрами `{ count, max }`. */
  textKey: string;
}

export function toSeatsVm(freeSlots: number, maxPlayers: number, viewMode: ViewMode): SeatsVm {
  const max = Math.max(0, maxPlayers);
  const free = Math.min(max, Math.max(0, freeSlots));
  const mode = viewMode === 'gm' ? 'free' : 'taken';
  const count = mode === 'free' ? free : max - free;
  return {
    mode,
    count,
    max,
    fill: max > 0 ? count / max : 0,
    textKey: mode === 'free' ? 'search.card.seatsFree' : 'search.card.seatsTaken',
  };
}
