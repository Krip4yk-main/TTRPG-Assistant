import type {
  TelegramActionInput,
  TelegramActionResult,
  TelegramOutboxFailedInput,
  TelegramOutboxItem,
} from '@nri/shared';

export type LinkResult =
  | { ok: true; nickname: string }
  | { ok: false; reason: 'taken' | 'expired' | 'banned' | 'already' | 'error' };

/**
 * Результат дії з кнопки: успіх або код помилки бекенда (`NOT_LINKED` — Telegram не
 * прив'язано; `ERROR` — мережа/невідома відповідь).
 */
export type ActionOutcome =
  { ok: true; result: TelegramActionResult['result'] } | { ok: false; code: string };

export type BackendClient = {
  /** Дія з кнопки сповіщення від імені власника Telegram-акаунта. Не кидає. */
  telegramAction(input: TelegramActionInput): Promise<ActionOutcome>;
  linkTelegram(
    token: string,
    telegramId: number | string,
    displayName: string,
  ): Promise<LinkResult>;
  /** Забирає пачку Telegram-повідомлень (лок на 2 хв). Кидає при збої. */
  claimOutbox(limit: number): Promise<TelegramOutboxItem[]>;
  /** Позначає повідомлення надісланим. Кидає при збої. */
  markSent(id: number): Promise<void>;
  /** Повідомляє про невдачу (тимчасову чи остаточну). Кидає при збої. */
  markFailed(id: number, input: TelegramOutboxFailedInput): Promise<void>;
};

/** Помилка виклику внутрішнього API (лише статус — без URL і тіла). */
export class BackendError extends Error {
  constructor(readonly status: number) {
    super(`backend responded ${status}`);
    this.name = 'BackendError';
  }
}

const REASONS: Record<string, 'taken' | 'expired' | 'banned' | 'already'> = {
  IDENTITY_TAKEN: 'taken',
  NOT_FOUND: 'expired',
  IDENTITY_BANNED: 'banned',
  PROVIDER_ALREADY_LINKED: 'already',
};

export function createBackendClient(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): BackendClient {
  const base = baseUrl.replace(/\/+$/, '');
  const post = async (path: string, body: unknown): Promise<Response> => {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new BackendError(res.status);
    return res;
  };
  return {
    async telegramAction(input) {
      try {
        const res = await fetchImpl(`${base}/telegram/action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-internal-key': apiKey },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const data = (await res.json().catch(() => null)) as {
          result?: unknown;
          error?: { code?: unknown; details?: { reason?: unknown } };
        } | null;
        if (res.ok && typeof data?.result === 'string') {
          return { ok: true, result: data.result as TelegramActionResult['result'] };
        }
        if (data?.error?.details?.reason === 'NOT_LINKED') return { ok: false, code: 'NOT_LINKED' };
        const code = data?.error?.code;
        return { ok: false, code: typeof code === 'string' ? code : 'ERROR' };
      } catch {
        return { ok: false, code: 'ERROR' };
      }
    },
    async claimOutbox(limit) {
      const res = await post('/telegram/outbox/claim', { limit });
      const data = (await res.json()) as { items?: TelegramOutboxItem[] };
      return Array.isArray(data.items) ? data.items : [];
    },
    async markSent(id) {
      await post(`/telegram/outbox/${id}/sent`, {});
    },
    async markFailed(id, input) {
      await post(`/telegram/outbox/${id}/failed`, input);
    },
    async linkTelegram(token, telegramId, displayName) {
      try {
        const res = await fetchImpl(`${base}/telegram/link`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-internal-key': apiKey },
          body: JSON.stringify({ token, telegramId, displayName }),
          // Бекенд, що «завис», не повинен тримати обробник апдейту вічно.
          signal: AbortSignal.timeout(timeoutMs),
        });
        const data = (await res.json().catch(() => null)) as {
          nickname?: string;
          error?: { code?: string };
        } | null;
        if (res.ok && typeof data?.nickname === 'string') {
          return { ok: true, nickname: data.nickname };
        }
        return { ok: false, reason: REASONS[data?.error?.code ?? ''] ?? 'error' };
      } catch {
        return { ok: false, reason: 'error' };
      }
    },
  };
}
