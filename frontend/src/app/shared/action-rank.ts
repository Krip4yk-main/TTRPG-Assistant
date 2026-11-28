import type { MatButtonAppearance } from '@angular/material/button';

/**
 * Ранг кнопки дії — одне правило ієрархії для всіх дизайнів: головна дія — залита, другорядні —
 * обведені, небезпечні — текстова кнопка кольору небезпеки дизайну (клас `nri-danger`, колір —
 * `--nri-danger-text` дизайну). Кольори рівнів — з палітри кожного дизайну (токени Material і
 * `--nri-*`), правило — спільне.
 *
 * Порядок у рядку — від краю, до якого рядок вирівняний: у рядках дій (картки, сторінка гри,
 * сесії) головна → другорядні → небезпечні зліва направо; у діалогах і підвалах форм (вирівняні
 * праворуч) — навпаки, головна біля правого краю.
 */
export type ActionRank = 'primary' | 'secondary' | 'danger';

/** Вигляд Material-кнопки (`[matButton]`) для рангу. */
export const RANK_APPEARANCE: Readonly<Record<ActionRank, MatButtonAppearance>> = {
  primary: 'filled',
  secondary: 'outlined',
  danger: 'text',
};

const RANK_ORDER: Readonly<Record<ActionRank, number>> = { primary: 0, secondary: 1, danger: 2 };

/** Стабільно впорядковує дії рядка: головна → другорядні → небезпечні. */
export function byRank<T extends { rank: ActionRank }>(actions: readonly T[]): T[] {
  return [...actions].sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank]);
}
