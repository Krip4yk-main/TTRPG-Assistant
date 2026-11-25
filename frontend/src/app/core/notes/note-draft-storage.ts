/**
 * Незбережений текст нотатки (конфлікт чи помилка, коли редактор закрили) у `localStorage`.
 * Ключ — на користувача й нотатку (`nri.noteDraft.<userId>.<scope>.<id>`). При наступному
 * відкритті редактор показує цей текст поруч з актуальною версією з сервера, щоб користувач
 * вибрав. При виході з акаунта всі копії видаляються (`clearAllNoteDrafts`).
 * Сховище може бути недоступним (приватний режим, квота) — тоді просто нічого не робимо.
 */
export const NOTE_DRAFT_PREFIX = 'nri.noteDraft.';

export function noteDraftKey(userId: number, noteKey: string): string {
  return `${NOTE_DRAFT_PREFIX}${userId}.${noteKey}`;
}

export function readNoteDraft(key: string): string | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { body?: unknown } | null;
    if (typeof parsed?.body === 'string') return parsed.body;
  } catch {
    // пошкоджений JSON чи недоступне сховище — видаляємо нижче
  }
  removeNoteDraft(key);
  return null;
}

export function writeNoteDraft(key: string, body: string): void {
  try {
    localStorage.setItem(key, JSON.stringify({ body, savedAt: Date.now() }));
  } catch {
    // Сховище недоступне чи переповнене.
  }
}

export function removeNoteDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Див. вище.
  }
}

/** Видаляє незбережені нотатки всіх користувачів (вихід, втрата сесії, видалення акаунта). */
export function clearAllNoteDrafts(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(NOTE_DRAFT_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Див. вище.
  }
}
