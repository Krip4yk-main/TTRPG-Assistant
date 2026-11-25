import { describe, expect, it, vi } from 'vitest';
import type { ActionOutcome } from '../api/backend-client.js';
import uk from '../i18n/uk.json' with { type: 'json' };
import { makeT } from '../i18n/t.js';
import { handleCallback, type CallbackCtx } from './callbacks.js';

const t = makeT();
const TEXT = '📜 Нова заявка на гру «Гра» від Гравець.\n\nДетальніше: https://s/x';
const APP_KB = {
  inline_keyboard: [
    [
      { text: uk.notify.buttons.approve, callback_data: 'a:9:ok' },
      { text: uk.notify.buttons.reject, callback_data: 'a:9:no' },
    ],
  ],
};
const RSVP_KB = {
  inline_keyboard: [
    [
      { text: uk.notify.buttons.going, callback_data: 'r:5:y' },
      { text: uk.notify.buttons.notGoing, callback_data: 'r:5:n' },
    ],
  ],
};

function setup(
  data: string | undefined,
  outcome: ActionOutcome,
  message: CallbackCtx['callbackQuery']['message'] = { text: TEXT, reply_markup: APP_KB },
) {
  const ctx = {
    callbackQuery: { data, from: { id: 777 }, message },
    answerCallbackQuery: vi.fn(async () => true),
    editMessageText: vi.fn(async () => true),
  };
  const client = { telegramAction: vi.fn(async () => outcome) };
  return { ctx, client };
}

describe('handleCallback', () => {
  it('approve: calls the backend as the presser, answers, edits text and removes the keyboard', async () => {
    const { ctx, client } = setup('a:9:ok', { ok: true, result: 'approved' });
    await handleCallback(ctx, client, t);
    expect(client.telegramAction).toHaveBeenCalledWith({
      telegramId: 777,
      action: 'approve',
      id: 9,
    });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: '✅ Затверджено' });
    expect(ctx.editMessageText).toHaveBeenCalledWith(`${TEXT}\n\n✅ Затверджено`, {
      reply_markup: { inline_keyboard: [] },
      link_preview_options: { is_disabled: true },
    });
    const other = (ctx.editMessageText.mock.calls[0] as unknown[])[1] as object;
    expect(other).not.toHaveProperty('parse_mode');
  });

  it('reject: «❌ Відхилено», keyboard removed', async () => {
    const { ctx, client } = setup('a:9:no', { ok: true, result: 'rejected' });
    await handleCallback(ctx, client, t);
    expect(client.telegramAction).toHaveBeenCalledWith({
      telegramId: 777,
      action: 'reject',
      id: 9,
    });
    expect(ctx.editMessageText).toHaveBeenCalledWith(`${TEXT}\n\n❌ Відхилено`, {
      reply_markup: { inline_keyboard: [] },
      link_preview_options: { is_disabled: true },
    });
  });

  it('rsvp keeps the keyboard and replaces the previous status line', async () => {
    const text = '⏰ Нагадування\n\nДетальніше: https://s/y';
    const { ctx, client } = setup(
      'r:5:n',
      { ok: true, result: 'not_going' },
      { text: `${text}\n\n👍 Ви будете`, reply_markup: RSVP_KB },
    );
    await handleCallback(ctx, client, t);
    expect(client.telegramAction).toHaveBeenCalledWith({
      telegramId: 777,
      action: 'rsvp',
      id: 5,
      value: 'not_going',
    });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: '🙅 Не зможете' });
    expect(ctx.editMessageText).toHaveBeenCalledWith(`${text}\n\n🙅 Не зможете`, {
      reply_markup: RSVP_KB,
      link_preview_options: { is_disabled: true },
    });
  });

  it('the same rsvp again: answers, does not edit (message would not change)', async () => {
    const text = '⏰ Нагадування\n\n👍 Ви будете';
    const { ctx, client } = setup(
      'r:5:y',
      { ok: true, result: 'going' },
      { text, reply_markup: RSVP_KB },
    );
    await handleCallback(ctx, client, t);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: '👍 Ви будете' });
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });

  it.each([
    ['FORBIDDEN', uk.actions.errors.FORBIDDEN],
    ['NOT_LINKED', uk.actions.errors.NOT_LINKED],
    ['NOT_A_MEMBER', uk.actions.errors.NOT_A_MEMBER],
    ['SESSION_INVALID_STATE', uk.actions.errors.SESSION_INVALID_STATE],
    ['APPLICATION_CLOSED', uk.actions.errors.APPLICATION_CLOSED],
    ['ERROR', uk.actions.errors.default],
    ['SOMETHING_NEW', uk.actions.errors.default],
  ])('error %s → translated answer, message untouched', async (code, text) => {
    const { ctx, client } = setup('a:9:ok', { ok: false, code });
    await handleCallback(ctx, client, t);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text });
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'x', 'a:9:yes', 'a:0:ok', 'r:5:ok', 'game:1'])(
    'foreign/malformed data %s → silent answer, no backend call',
    async (data) => {
      const { ctx, client } = setup(data, { ok: true, result: 'approved' });
      await handleCallback(ctx, client, t);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith();
      expect(client.telegramAction).not.toHaveBeenCalled();
      expect(ctx.editMessageText).not.toHaveBeenCalled();
    },
  );

  it('inaccessible message → answers only; edit failure is logged, not thrown', async () => {
    const a = setup('a:9:ok', { ok: true, result: 'approved' }, {});
    await handleCallback(a.ctx, a.client, t);
    expect(a.ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: '✅ Затверджено' });
    expect(a.ctx.editMessageText).not.toHaveBeenCalled();

    const b = setup('a:9:ok', { ok: true, result: 'approved' });
    b.ctx.editMessageText.mockRejectedValueOnce(new Error('message to edit not found'));
    const log = vi.fn();
    await handleCallback(b.ctx, b.client, t, log);
    expect(log).toHaveBeenCalledOnce();
  });

  it('keeps the edited text within the Telegram limit', async () => {
    const long = 'я'.repeat(4096);
    const { ctx, client } = setup('a:9:ok', { ok: true, result: 'approved' }, { text: long });
    await handleCallback(ctx, client, t);
    const text = (ctx.editMessageText.mock.calls[0] as unknown[])[0] as string;
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text.endsWith('\n\n✅ Затверджено')).toBe(true);
  });
});
