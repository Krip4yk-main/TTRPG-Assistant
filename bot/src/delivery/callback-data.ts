import type { TelegramButton } from '@nri/shared';

/** Ліміт Telegram на `callback_data`, байти. */
export const CALLBACK_DATA_MAX_BYTES = 64;

/**
 * Дія з кнопки сповіщення. Формат `callback_data`:
 * `a:<applicationId>:ok|no` — затвердити / відхилити заявку;
 * `r:<sessionId>:y|n` — RSVP на сесію (буду / не зможу).
 */
export type CallbackAction =
  | { action: 'approve' | 'reject'; id: number }
  | { action: 'rsvp'; id: number; value: 'going' | 'not_going' };

export function encodeCallback(b: TelegramButton): string {
  const data =
    b.action === 'rsvp'
      ? `r:${b.sessionId}:${b.value === 'going' ? 'y' : 'n'}`
      : `a:${b.applicationId}:${b.action === 'approve' ? 'ok' : 'no'}`;
  if (Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_MAX_BYTES) {
    throw new Error('callback_data too long');
  }
  return data;
}

/** Розбирає `callback_data`; чуже чи зіпсоване — `null`. */
export function parseCallback(data: string): CallbackAction | null {
  const m = /^(a|r):([1-9]\d{0,15}):(ok|no|y|n)$/.exec(data);
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id)) return null;
  if (m[1] === 'a') {
    if (m[3] === 'ok') return { action: 'approve', id };
    if (m[3] === 'no') return { action: 'reject', id };
    return null;
  }
  if (m[3] === 'y') return { action: 'rsvp', id, value: 'going' };
  if (m[3] === 'n') return { action: 'rsvp', id, value: 'not_going' };
  return null;
}
