/**
 * Незбережені значення форми гри в `localStorage`. Ключ — на користувача й гру
 * (`nri.gameDraft.<userId>.<gameId|new>`), тож чужа чи інша гра їх не підхопить.
 * Сховище може бути недоступним (приватний режим, квота) — тоді просто нічого не робимо.
 */
export const GAME_DRAFT_PREFIX = 'nri.gameDraft.';
const VERSION = 1;

/** Значення форми у вигляді, придатному для JSON (дата — `YYYY-MM-DD`). */
export type StoredGameValues = Record<string, unknown>;

export function gameDraftKey(userId: number, gameId: number | null): string {
  return `${GAME_DRAFT_PREFIX}${userId}.${gameId ?? 'new'}`;
}

export function readGameDraft(key: string): StoredGameValues | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { v?: unknown; values?: unknown };
    if (parsed?.v !== VERSION) return null;
    const values = parsed.values;
    if (typeof values !== 'object' || values === null || Array.isArray(values)) return null;
    return values as StoredGameValues;
  } catch {
    return null;
  }
}

export function writeGameDraft(key: string, values: StoredGameValues): void {
  try {
    localStorage.setItem(key, JSON.stringify({ v: VERSION, values }));
  } catch {
    // Сховище недоступне чи переповнене — автозбереження просто не працює.
  }
}

export function removeGameDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Див. вище.
  }
}
