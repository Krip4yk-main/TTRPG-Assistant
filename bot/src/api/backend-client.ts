export type LinkResult =
  | { ok: true; nickname: string }
  | { ok: false; reason: 'taken' | 'expired' | 'banned' | 'already' | 'error' };

export type BackendClient = {
  linkTelegram(
    token: string,
    telegramId: number | string,
    displayName: string,
  ): Promise<LinkResult>;
};

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
): BackendClient {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    async linkTelegram(token, telegramId, displayName) {
      try {
        const res = await fetchImpl(`${base}/telegram/link`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-internal-key': apiKey },
          body: JSON.stringify({ token, telegramId, displayName }),
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
