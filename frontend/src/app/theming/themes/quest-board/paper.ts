/** Скільки варіантів рваного обрису пергаменту (`data-paper`, маски — у quest-board.less). */
export const PAPERS = 6;

/**
 * Варіант обрису пергаменту за id гри — спільний для оголошення пошуку й «Моїх ігор»:
 * стабільний між перерисовками, а в сусідніх ігор (id підряд) — різний. Доданок `id / 6`
 * розводить обрис і нахил оголошення (теж `id % 6`): кожен обрис трапляється з кожним нахилом.
 */
export function paperVariant(id: number): number {
  const n = Math.abs(id);
  return (n + Math.floor(n / PAPERS)) % PAPERS;
}
