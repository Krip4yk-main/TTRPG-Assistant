import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrammyError, HttpError } from 'grammy';
import type { TelegramOutboxItem } from '@nri/shared';
import {
  classifySendError,
  deliverOnce,
  newDeliveryState,
  startPoller,
  type PollerDeps,
} from './poller.js';
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
  timeZone: null,
  silent: false,
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

  it('silent → sent with disable_notification; otherwise with sound', async () => {
    const { sendMessage, deps } = setup([item(1, { silent: true }), item(2)], async () => ({}));
    await deliverOnce(deps);
    const opts = sendMessage.mock.calls.map((c) => (c as unknown[])[2] as Record<string, unknown>);
    expect(opts[0]).toMatchObject({ disable_notification: true });
    expect(opts[1]).not.toHaveProperty('disable_notification');
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

  it('network → retryable; one failure does not stop the batch', async () => {
    const { client, deps } = setup([item(1), item(2)], async (chatId) => {
      if (chatId === '1001') throw new HttpError('Network request failed', new Error('ECONNRESET'));
      return {};
    });
    await deliverOnce(deps);
    expect(client.markFailed).toHaveBeenCalledWith(1, { retryable: true, error: 'network error' });
    expect(client.markSent).toHaveBeenCalledWith(2);
  });

  it('429 stops the batch: the rest is reported rateLimited with the same retry_after', async () => {
    const { client, sendMessage, deps } = setup([item(1), item(2), item(3), item(4)], async (c) => {
      if (c === '1002') throw tgError(429, 'Too Many Requests', { retry_after: 7 });
      return {};
    });
    await deliverOnce(deps);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(client.markSent.mock.calls).toEqual([[1]]);
    expect(client.markFailed).toHaveBeenCalledWith(2, {
      retryable: true,
      rateLimited: true,
      retryAfterSec: 7,
      error: '429: Too Many Requests',
    });
    for (const id of [3, 4]) {
      expect(client.markFailed).toHaveBeenCalledWith(id, {
        retryable: true,
        rateLimited: true,
        retryAfterSec: 7,
        error: 'rate limited',
      });
    }
  });

  it('a failing sent report is logged, remembered and retried first; no second send', async () => {
    const { client, sendMessage, deps } = setup([item(1), item(2)], async () => ({}));
    client.markSent.mockRejectedValueOnce(new Error('backend down'));
    const log = vi.fn();
    const state = newDeliveryState();
    await deliverOnce({ ...deps, log }, 20, state);
    expect(client.markSent).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledOnce();
    expect([...state.unreportedSent]).toEqual([1]);
    // Наступний цикл: спершу повтор звіту (до видачі), нічого не надсилається вдруге.
    client.markSent.mockClear();
    sendMessage.mockClear();
    client.claimOutbox.mockResolvedValueOnce([]);
    await deliverOnce({ ...deps, log }, 20, state);
    expect(client.markSent.mock.calls).toEqual([[1]]);
    expect(client.markSent.mock.invocationCallOrder[0]!).toBeLessThan(
      client.claimOutbox.mock.invocationCallOrder.at(-1)!,
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(state.unreportedSent.size).toBe(0);
  });

  it('a re-claimed id that is still unreported is only reported, not re-sent', async () => {
    const { client, sendMessage, deps } = setup([item(5)], async () => ({}));
    const state = newDeliveryState();
    state.unreportedSent.add(5);
    client.markSent.mockRejectedValueOnce(new Error('still down'));
    await deliverOnce(deps, 20, state);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(client.markSent.mock.calls).toEqual([[5], [5]]);
    expect(state.unreportedSent.size).toBe(0);
  });

  it('render error → non-retryable failure, nothing sent', async () => {
    const { client, sendMessage, deps } = setup([item(1), item(2)], async () => ({}));
    const render = vi.fn((i: TelegramOutboxItem) => {
      if (i.id === 1) throw new TypeError('boom');
      return deps.render(i);
    });
    await deliverOnce({ ...deps, render });
    expect(client.markFailed).toHaveBeenCalledWith(1, {
      retryable: false,
      error: 'render error: TypeError',
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(client.markSent).toHaveBeenCalledWith(2);
  });

  it('a reminder for a session that already started → failed stale, not sent', async () => {
    const now = new Date('2026-11-25T10:00:00Z');
    const reminder = (id: number, startsAt: string) =>
      item(id, {
        kind: 'session.reminder',
        params: { gameId: 1, gameTitle: 'Гра', sessionId: 3, startsAt, offsetMin: 60 },
        buttons: null,
      });
    const { client, sendMessage, deps } = setup(
      [reminder(1, '2026-11-25T09:59:00Z'), reminder(2, '2026-11-25T11:00:00Z')],
      async () => ({}),
    );
    await deliverOnce({ ...deps, now: () => now });
    expect(client.markFailed).toHaveBeenCalledWith(1, { retryable: false, error: 'stale' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(client.markSent).toHaveBeenCalledWith(2);
  });
});

describe('classifySendError', () => {
  it.each([
    [tgError(403, 'Forbidden: user is deactivated'), { retryable: false, chatUnreachable: true }],
    [tgError(400, 'Bad Request: chat not found'), { retryable: false, chatUnreachable: true }],
    [tgError(400, 'Bad Request: message is too long'), { retryable: false }],
    [tgError(429, 'Too Many Requests'), { retryable: true, rateLimited: true }],
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
