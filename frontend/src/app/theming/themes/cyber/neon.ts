/** Кольори неону кібер-карток (`data-neon`; значення кольорів — у бандлі кожного дизайну). */
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
