import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrammyError, HttpError } from 'grammy';
import type { TelegramOutboxItem } from '@nri/shared';
import { classifySendError, deliverOnce, startPoller, type PollerDeps } from './poller.js';
import { renderNotification } from './render.js';

const tgError = (code: number, description: string, parameters = {}) =>
  new GrammyError(
    `Call to 'sendMessage' failed! (${code}: ${description})`,
    { ok: false, error_code: code, description, parameters },
    'sendMessage',
    {},
  );

const item = (id: number, extra: Partial<TelegramOutboxItem> = {}): TelegramOutboxItem => ({
  id,
  chatId: String(1000 + id),
  kind: 'application.created',
  params: { gameId: 1, gameTitle: '<b>Гра</b>', applicationId: 9 },
  buttons: [
    { action: 'approve', applicationId: 9 },
    { action: 'reject', applicationId: 9 },
  ],
  attempts: 0,
  ...extra,
});

function setup(items: TelegramOutboxItem[], send: (chatId: string) => Promise<unknown>) {
  const client = {
    claimOutbox: vi.fn(async () => items),
    markSent: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
  };
  const sendMessage = vi.fn(async (chatId: string) => send(chatId));
  const deps: PollerDeps = {
    client,
    api: { sendMessage },
    render: (i) => renderNotification(i.kind, i.params, i.buttons, { siteUrl: 'https://s' }),
    log: () => {},
  };
  return { client, sendMessage, deps };
}

describe('deliverOnce', () => {
  it('sends plain text with an inline keyboard and reports sent', async () => {
    const { client, sendMessage, deps } = setup([item(1)], async () => ({}));
    expect(await deliverOnce(deps)).toBe(1);
    expect(client.claimOutbox).toHaveBeenCalledWith(20);
    const [chatId, text, other] = sendMessage.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(chatId).toBe('1001');
    expect(text).toContain('«<b>Гра</b>»');
    expect(other).not.toHaveProperty('parse_mode');
    expect(other.reply_markup).toEqual({
      inline_keyboard: [
        [
          expect.objectContaining({ callback_data: 'a:9:ok' }),
          expect.objectContaining({ callback_data: 'a:9:no' }),
        ],
      ],
    });
    expect(client.markSent).toHaveBeenCalledWith(1);
    expect(client.markFailed).not.toHaveBeenCalled();
  });

  it('omits reply_markup when there are no buttons', async () => {
    const { sendMessage, deps } = setup([item(1, { buttons: null })], async () => ({}));
    await deliverOnce(deps);
    expect((sendMessage.mock.calls[0] as unknown[])[2]).not.toHaveProperty('reply_markup');
  });

  it('403 blocked → failed, not retryable, chat unreachable', async () => {
    const { client, deps } = setup([item(1)], async () => {
      throw tgError(403, 'Forbidden: bot was blocked by the user');
    });
    await deliverOnce(deps);
    expect(client.markSent).not.toHaveBeenCalled();
    expect(client.markFailed).toHaveBeenCalledWith(1, {
      retryable: false,
      chatUnreachable: true,
      error: '403: Forbidden: bot was blocked by the user',
    });
  });

  it('429 → retryable with retry_after; network → retryable; one failure does not stop the batch', async () => {
    const { client, deps } = setup([item(1), item(2), item(3)], async (chatId) => {
      if (chatId === '1001') throw tgError(429, 'Too Many Requests', { retry_after: 7 });
      if (chatId === '1002') throw new HttpError('Network request failed', new Error('ECONNRESET'));
      return {};
    });
    await deliverOnce(deps);
    expect(client.markFailed).toHaveBeenCalledWith(1, {
      retryable: true,
      retryAfterSec: 7,
      error: '429: Too Many Requests',
    });
    expect(client.markFailed).toHaveBeenCalledWith(2, { retryable: true, error: 'network error' });
    expect(client.markSent).toHaveBeenCalledWith(3);
  });

  it('a failing report is logged and the batch continues', async () => {
    const { client, deps } = setup([item(1), item(2)], async () => ({}));
    client.markSent.mockRejectedValueOnce(new Error('backend down'));
    const log = vi.fn();
    await deliverOnce({ ...deps, log });
    expect(client.markSent).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledOnce();
  });
});

describe('classifySendError', () => {
  it.each([
    [tgError(403, 'Forbidden: user is deactivated'), { retryable: false, chatUnreachable: true }],
    [tgError(400, 'Bad Request: chat not found'), { retryable: false, chatUnreachable: true }],
    [tgError(400, 'Bad Request: message is too long'), { retryable: false }],
    [tgError(429, 'Too Many Requests'), { retryable: true }],
    [tgError(502, 'Bad Gateway'), { retryable: true }],
    [new Error('boom'), { retryable: true, error: 'Error' }],
    ['weird', { retryable: true, error: 'unknown error' }],
  ])('%s', (err, expected) => {
    const r = classifySendError(err);
    expect(r).toMatchObject(expected);
    if (!('chatUnreachable' in expected)) expect(r.chatUnreachable).toBeUndefined();
  });
});

describe('startPoller', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls on the interval and never overlaps', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let inFlight = 0;
    let maxInFlight = 0;
    const claimOutbox = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => (release = r));
      inFlight--;
      return [];
    });
    const poller = startPoller(
      {
        client: { claimOutbox, markSent: vi.fn(), markFailed: vi.fn() },
        api: { sendMessage: vi.fn() },
        render: () => ({ text: '', keyboard: undefined }),
        log: () => {},
      },
      { intervalMs: 3000 },
    );
    expect(claimOutbox).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(claimOutbox).toHaveBeenCalledTimes(1);
    // Цикл «завис» — ні таймер, ні ручний tick не запускають другий.
    await vi.advanceTimersByTimeAsync(10_000);
    void poller.tick();
    expect(claimOutbox).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(claimOutbox).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    release();
    await poller.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(claimOutbox).toHaveBeenCalledTimes(2);
  });

  it('a failed claim is logged and polling continues', async () => {
    vi.useFakeTimers();
    const claimOutbox = vi
      .fn<() => Promise<TelegramOutboxItem[]>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue([]);
    const log = vi.fn();
    const poller = startPoller(
      {
        client: { claimOutbox, markSent: vi.fn(), markFailed: vi.fn() },
        api: { sendMessage: vi.fn() },
        render: () => ({ text: '', keyboard: undefined }),
        log,
      },
      { intervalMs: 100 },
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(claimOutbox).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('outbox poll failed (down)');
    await poller.stop();
  });

  it('stop waits for the in-flight cycle', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const claimOutbox = vi.fn(
      () => new Promise<TelegramOutboxItem[]>((r) => (release = () => r([]))),
    );
    const poller = startPoller(
      {
        client: { claimOutbox, markSent: vi.fn(), markFailed: vi.fn() },
        api: { sendMessage: vi.fn() },
        render: () => ({ text: '', keyboard: undefined }),
      },
      { intervalMs: 10 },
    );
    await vi.advanceTimersByTimeAsync(10);
    let stopped = false;
    const s = poller.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release();
    await s;
    expect(stopped).toBe(true);
  });
});
