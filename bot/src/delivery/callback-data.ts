import type { PollVoteValue, TelegramButton } from '@nri/shared';

/** Ліміт Telegram на `callback_data`, байти. */
export const CALLBACK_DATA_MAX_BYTES = 64;

/**
 * Дія з кнопки сповіщення. Формат `callback_data`:
 * `a:<applicationId>:ok|no` — затвердити / відхилити заявку;
 * `r:<sessionId>:y|n` — RSVP на сесію (буду / не зможу);
 * `v:<optionId>:y|n|m` — відповідь на варіант голосування за час (можу / не можу / якщо треба).
 */
export type CallbackAction =
  | { action: 'approve' | 'reject'; id: number }
  | { action: 'rsvp'; id: number; value: 'going' | 'not_going' }
  | { action: 'vote'; id: number; value: PollVoteValue };

const VOTE_CODE: Record<PollVoteValue, string> = { yes: 'y', no: 'n', maybe: 'm' };

export function encodeCallback(b: TelegramButton): string {
  let data: string;
  switch (b.action) {
    case 'rsvp':
      data = `r:${b.sessionId}:${b.value === 'going' ? 'y' : 'n'}`;
      break;
    case 'vote':
      data = `v:${b.optionId}:${VOTE_CODE[b.value]}`;
      break;
    default:
      data = `a:${b.applicationId}:${b.action === 'approve' ? 'ok' : 'no'}`;
  }
  if (Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_MAX_BYTES) {
    throw new Error('callback_data too long');
  }
  return data;
}

/** Розбирає `callback_data`; чуже чи зіпсоване — `null`. */
export function parseCallback(data: string): CallbackAction | null {
  const m = /^(a|r|v):([1-9]\d{0,15}):(ok|no|y|n|m)$/.exec(data);
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id)) return null;
  switch (m[1]) {
    case 'a':
      if (m[3] === 'ok') return { action: 'approve', id };
      if (m[3] === 'no') return { action: 'reject', id };
      return null;
    case 'r':
      if (m[3] === 'y') return { action: 'rsvp', id, value: 'going' };
      if (m[3] === 'n') return { action: 'rsvp', id, value: 'not_going' };
      return null;
    default:
      if (m[3] === 'y') return { action: 'vote', id, value: 'yes' };
      if (m[3] === 'n') return { action: 'vote', id, value: 'no' };
      if (m[3] === 'm') return { action: 'vote', id, value: 'maybe' };
      return null;
  }
}
