/**
 * Варіанти кольору карток сцени (`data-neon`; назва — з кібер-дизайнів, значення кольорів — у
 * бандлі кожного дизайну, не кібер-дизайн кладе в ці шість слотів свої варіанти).
 */
export const NEONS = ['pink', 'cyan', 'violet', 'amber', 'lime', 'red'] as const;
export type Neon = (typeof NEONS)[number];

/**
 * Колір неону за id гри — спільний для картки пошуку й «Моїх ігор»: стабільний між
 * перерисовками, а в сусідніх ігор (id підряд) — різний (те саме правило, що в обрису
 * пергаменту «Дошки»: доданок `id / 6` розводить колір і остачу `id % 6`).
 */
export function neonOf(id: number): Neon {
  const n = Math.abs(id);
  return NEONS[(n + Math.floor(n / NEONS.length)) % NEONS.length]!;
}
