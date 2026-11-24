import { describe, expect, it, vi } from 'vitest';
import { createBackendClient } from './api/backend-client.js';
import type { BackendClient, LinkResult } from './api/backend-client.js';
import { handleStart, makeT } from './bot.js';
import uk from './i18n/uk.json' with { type: 'json' };

const t = makeT();
const from = { id: 42, username: 'hero_tg', first_name: 'Hero' };

function setup(match: string, result: LinkResult) {
  const reply = vi.fn<(text: string) => Promise<void>>(async () => undefined);
  const client: BackendClient = { linkTelegram: vi.fn(async () => result) };
  return { reply, client, ctx: { match, from, reply } };
}

describe('handleStart', () => {
  it('links with the token and replies link.success with nickname', async () => {
    const { ctx, client, reply } = setup('abc', { ok: true, nickname: 'Gandalf' });
    await handleStart(ctx, client, t);
    expect(client.linkTelegram).toHaveBeenCalledWith('abc', 42, 'hero_tg');
    expect(reply).toHaveBeenCalledWith(uk.link.success.replace('{nickname}', 'Gandalf'));
  });

  it('falls back to first_name when there is no username', async () => {
    const { client, reply } = setup('abc', { ok: true, nickname: 'N' });
    await handleStart({ match: 'abc', from: { id: 1, first_name: 'Bob' }, reply }, client, t);
    expect(client.linkTelegram).toHaveBeenCalledWith('abc', 1, 'Bob');
  });

  it.each(['taken', 'expired', 'banned', 'already', 'error'] as const)(
    'maps %s',
    async (reason) => {
      const { ctx, client, reply } = setup('abc', { ok: false, reason });
      await handleStart(ctx, client, t);
      expect(reply).toHaveBeenCalledWith(uk.link[reason]);
    },
  );

  it('replies welcome without a token and does not call the backend', async () => {
    const { ctx, client, reply } = setup('', { ok: true, nickname: 'x' });
    await handleStart(ctx, client, t);
    expect(client.linkTelegram).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(uk.start.welcome);
  });
});

describe('createBackendClient', () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const make = (res: Response | Error) => {
    const f = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => {
      if (res instanceof Error) throw res;
      return res;
    });
    return {
      f,
      client: createBackendClient('http://x/api/internal/', 'k', f as unknown as typeof fetch),
    };
  };

  it('sends key and body, returns nickname on success', async () => {
    const { f, client } = make(json(200, { ok: true, nickname: 'Hero' }));
    expect(await client.linkTelegram('tok', 7, 'n')).toEqual({ ok: true, nickname: 'Hero' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://x/api/internal/telegram/link');
    expect((init.headers as Record<string, string>)['x-internal-key']).toBe('k');
    expect(JSON.parse(init.body as string)).toEqual({
      token: 'tok',
      telegramId: 7,
      displayName: 'n',
    });
  });

  it.each([
    [409, 'IDENTITY_TAKEN', 'taken'],
    [404, 'NOT_FOUND', 'expired'],
    [403, 'IDENTITY_BANNED', 'banned'],
    [409, 'PROVIDER_ALREADY_LINKED', 'already'],
    [401, 'UNAUTHENTICATED', 'error'],
    [500, 'INTERNAL', 'error'],
  ] as const)('maps %i %s -> %s', async (status, code, reason) => {
    const { client } = make(json(status, { error: { code } }));
    expect(await client.linkTelegram('t', 1, 'n')).toEqual({ ok: false, reason });
  });

  it('network failure -> error', async () => {
    const { client } = make(new Error('down'));
    expect(await client.linkTelegram('t', 1, 'n')).toEqual({ ok: false, reason: 'error' });
  });
});
