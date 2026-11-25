import { describe, expect, it } from 'vitest';
import { NOTIFICATION_TYPES, type NotificationParams, type TelegramButton } from '@nri/shared';
import uk from '../i18n/uk.json' with { type: 'json' };
import { CALLBACK_DATA_MAX_BYTES, encodeCallback, parseCallback } from './callback-data.js';
import { formatWhen, renderNotification } from './render.js';

const SITE = 'https://nri.example/';
const base: NotificationParams = {
  gameId: 12,
  gameTitle: 'Прокляття Страда',
  applicationId: 34,
  sessionId: 56,
  // 19:00 за Києвом (UTC+2 у листопаді).
  startsAt: '2026-11-27T17:00:00.000Z',
  from: '2026-11-26T16:30:00.000Z',
  actor: { publicId: 'p1', nickname: 'Ґендальф' },
};
const render = (kind: string, p: NotificationParams = base, b: TelegramButton[] | null = null) =>
  renderNotification(kind, p, b, { siteUrl: SITE });

describe('renderNotification', () => {
  it.each(NOTIFICATION_TYPES)('%s: has a real template, game title and site link', (kind) => {
    const { text } = render(kind, { ...base, offsetMin: 60, reason: 'Хворію' });
    expect(text).not.toContain('notify.');
    expect(text).not.toMatch(/\{\w+\}/);
    expect(text).toContain('Прокляття Страда');
    expect(text).toMatch(/Детальніше: https:\/\/nri\.example\/(games\/12|my-applications)/);
  });

  it('every NotificationType has a uk.json template', () => {
    for (const kind of NOTIFICATION_TYPES) {
      const [group, name] = kind.split('.') as [string, string];
      const g = (uk.notify as Record<string, unknown>)[group] as Record<string, unknown>;
      expect(typeof g[name], kind).toBe('string');
    }
  });

  it('application.created: actor, link to applications, approve/reject buttons', () => {
    const r = render('application.created', base, [
      { action: 'approve', applicationId: 34 },
      { action: 'reject', applicationId: 34 },
    ]);
    expect(r.text).toContain('Ґендальф');
    expect(r.text).toContain('https://nri.example/games/12/applications');
    expect(r.keyboard).toEqual([
      [
        { text: uk.notify.buttons.approve, callback_data: 'a:34:ok' },
        { text: uk.notify.buttons.reject, callback_data: 'a:34:no' },
      ],
    ]);
  });

  it('session.reminder: offset phrasing, Kyiv time, RSVP buttons', () => {
    const r = render('session.reminder', { ...base, offsetMin: 1440 }, [
      { action: 'rsvp', sessionId: 56, value: 'going' },
      { action: 'rsvp', sessionId: 56, value: 'not_going' },
    ]);
    expect(r.text).toContain(uk.notify.offset['1440']);
    expect(r.text).toContain('19:00');
    expect(r.text).toContain('27');
    expect(r.keyboard![0]!.map((b) => b.callback_data)).toEqual(['r:56:y', 'r:56:n']);
    expect(render('session.reminder', { ...base, offsetMin: 60 }).text).toContain('за годину');
    expect(render('session.reminder', { ...base, offsetMin: 15 }).text).toContain('15 хвилин');
    expect(render('session.reminder', { ...base, offsetMin: 7 }).text).toContain('за 7 хв');
  });

  it('session.rescheduled shows old and new time; cancelled shows the reason', () => {
    const r = render('session.rescheduled');
    expect(r.text).toContain('18:30');
    expect(r.text).toContain('19:00');
    const c = render('session.cancelled', { ...base, reason: 'Майстер захворів' });
    expect(c.text).toContain('Причина: Майстер захворів');
    expect(render('session.cancelled', { ...base, reason: null }).text).not.toContain('Причина');
  });

  it('account_deleted reason uses the dedicated variant', () => {
    const left = render('member.left', { ...base, actor: null, reason: 'account_deleted' });
    expect(left.text).toContain(
      uk.notify.member.left_account_deleted.replace('{game}', base.gameTitle!),
    );
    expect(render('member.left').text).toContain('Ґендальф покидає');
    expect(render('game.cancelled', { ...base, reason: 'account_deleted' }).text).toContain(
      'акаунт майстра видалено',
    );
    expect(
      render('application.withdrawn', { ...base, actor: null, reason: 'account_deleted' }).text,
    ).toContain('акаунт гравця видалено');
  });

  it('missing actor/title/time fall back to neutral words', () => {
    const r = render('application.created', { gameId: 1 });
    expect(r.text).toContain(uk.notify.someone);
    expect(r.text).toContain(uk.notify.unknownGame);
    expect(render('session.cancelled', { gameId: 1 }).text).toContain(uk.notify.unknownTime);
  });

  it('passes HTML-ish values through as plain text (sent without parse_mode)', () => {
    const evil = '<b>Бал</b> & <a href="x">link</a> {actor}';
    const r = render('application.created', {
      ...base,
      gameTitle: evil,
      actor: { publicId: 'p', nickname: '<i>Хакер</i>&amp;' },
    });
    expect(r.text).toContain(`«${evil}»`);
    expect(r.text).toContain('<i>Хакер</i>&amp;');
    const s = render('session.cancelled', { ...base, reason: '<script>x</script>' });
    expect(s.text).toContain('Причина: <script>x</script>');
  });

  it('game.finished appends the genre thank-you, falling back to default', () => {
    const genres = [
      'fantasy',
      'dark-fantasy',
      'horror',
      'cyberpunk',
      'scifi',
      'postapoc',
      'steampunk',
      'noir',
      'historical',
      'superhero',
      'comedy',
    ];
    const thanks = uk.thanks as Record<string, string>;
    const texts = new Set<string>();
    for (const g of genres) {
      expect(thanks[g], g).toBeTruthy();
      const r = render('game.finished', { ...base, genreSlug: g });
      expect(r.text).toContain(thanks[g]);
      expect(r.text).toContain('завершено');
      texts.add(thanks[g]!);
    }
    expect(texts.size).toBe(11);
    expect(Object.keys(thanks).sort()).toEqual([...genres, 'default'].sort());
    for (const t of Object.values(thanks)) expect(t).not.toMatch(/донат|підтрима|monobank/i);
    expect(render('game.finished', { ...base, genreSlug: 'unknown' }).text).toContain(
      thanks.default,
    );
    expect(render('game.finished', { ...base, genreSlug: null }).text).toContain(thanks.default);
  });

  it('unknown kind → generic text, no crash', () => {
    expect(render('something.new', {}).text).toBe(uk.notify.generic);
  });

  it('caps text at the Telegram limit', () => {
    const r = render('session.cancelled', { ...base, reason: 'x'.repeat(5000) });
    expect(r.text.length).toBeLessThanOrEqual(4096);
  });

  it('no buttons → no keyboard', () => {
    expect(render('game.started').keyboard).toBeUndefined();
  });
});

describe('formatWhen', () => {
  it('uses Europe/Kyiv by default and a given zone otherwise', () => {
    expect(formatWhen('2026-07-01T12:00:00.000Z')).toContain('15:00');
    expect(formatWhen('2026-07-01T12:00:00.000Z', 'UTC')).toContain('12:00');
    expect(formatWhen('nope')).toBeNull();
    expect(formatWhen(undefined)).toBeNull();
  });
});

describe('callback data', () => {
  it('round-trips and stays within 64 bytes even for huge ids', () => {
    const big = Number.MAX_SAFE_INTEGER;
    const buttons: TelegramButton[] = [
      { action: 'approve', applicationId: big },
      { action: 'reject', applicationId: big },
      { action: 'rsvp', sessionId: big, value: 'going' },
      { action: 'rsvp', sessionId: big, value: 'not_going' },
    ];
    for (const b of buttons) {
      const data = encodeCallback(b);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
      expect(parseCallback(data)).toEqual(
        b.action === 'rsvp'
          ? { action: 'rsvp', id: big, value: b.value }
          : { action: b.action, id: big },
      );
    }
  });

  it('rejects foreign or malformed data', () => {
    for (const d of ['', 'a:1:y', 'r:1:ok', 'a:0:ok', 'a:-1:ok', 'a:01:ok', 'x:1:ok', 'a:1:ok:x']) {
      expect(parseCallback(d), d).toBeNull();
    }
  });
});
