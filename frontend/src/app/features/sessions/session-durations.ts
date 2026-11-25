/** Тривалість сесії: 30 хв … 12 год з кроком 30 хв (як у схемі). */
export const SESSION_DURATIONS = Array.from({ length: 24 }, (_, i) => (i + 1) * 30);
