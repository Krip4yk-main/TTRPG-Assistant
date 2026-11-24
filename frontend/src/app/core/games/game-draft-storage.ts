/**
 * Незбережені значення форми гри в `localStorage`. Ключ — на користувача й гру
 * (`nri.gameDraft.<userId>.<gameId|new>`), тож чужа чи інша гра їх не підхопить.
 * Копія живе не довше `GAME_DRAFT_TTL_MS` і пам'ятає `updatedAt` гри на сервері, щоб
 * не накласти застарілі зміни на новішу версію. При виході з акаунта всі копії
 * видаляються (`clearAllGameDrafts`) — у них можуть бути адреса й посилання.
 * Сховище може бути недоступним (приватний режим, квота) — тоді просто нічого не робимо.
 */
export const GAME_DRAFT_PREFIX = 'nri.gameDraft.';
export const GAME_DRAFT_TTL_MS = 7 * 86_400_000;
const VERSION = 1;

/** Значення форми у вигляді, придатному для JSON (дата — `YYYY-MM-DD`). */
export type StoredGameValues = Record<string, unknown>;

export interface StoredGameDraft {
  values: StoredGameValues;
  /** `updatedAt` гри на сервері, на яку накладено зміни; `null` — нова гра. */
  updatedAt: string | null;
}

export function gameDraftKey(userId: number, gameId: number | null): string {
  return `${GAME_DRAFT_PREFIX}${userId}.${gameId ?? 'new'}`;
}

/** Читає копію; пошкоджена чи прострочена — видаляється й повертається `null`. */
export function readGameDraft(key: string, now = Date.now()): StoredGameDraft | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as {
      v?: unknown;
      savedAt?: unknown;
      updatedAt?: unknown;
      values?: unknown;
    };
    const { values, savedAt, updatedAt } = parsed ?? {};
    const valid =
      parsed?.v === VERSION &&
      typeof savedAt === 'number' &&
      now - savedAt <= GAME_DRAFT_TTL_MS &&
      (updatedAt === null || typeof updatedAt === 'string') &&
      typeof values === 'object' &&
      values !== null &&
      !Array.isArray(values);
    if (valid) return { values: values as StoredGameValues, updatedAt: updatedAt as string | null };
  } catch {
    // пошкоджений JSON — видаляємо нижче
  }
  removeGameDraft(key);
  return null;
}

export function writeGameDraft(
  key: string,
  values: StoredGameValues,
  updatedAt: string | null,
  now = Date.now(),
): void {
  try {
    localStorage.setItem(key, JSON.stringify({ v: VERSION, savedAt: now, updatedAt, values }));
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

/** Видаляє копії форм усіх користувачів (вихід, втрата сесії, видалення акаунта). */
export function clearAllGameDrafts(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(GAME_DRAFT_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Див. вище.
  }
}
