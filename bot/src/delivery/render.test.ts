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
  const MODERATION = [
    'complaint.resolved',
    'moderation.digest',
    'sanction.imposed',
    'sanction.lifted',
    'appeal.decided',
  ];
  const gameTypes = NOTIFICATION_TYPES.filter((k) => !MODERATION.includes(k));

  it.each(gameTypes)('%s: has a real template, game title and site link', (kind) => {
    const { text } = render(kind, { ...base, offsetMin: 60, reason: 'Хворію' });
    expect(text).not.toContain('notify.');
    expect(text).not.toMatch(/\{\w+\}/);
    expect(text).toContain('Прокляття Страда');
    expect(text).toMatch(
      /Детальніше: https:\/\/nri\.example\/(games\/12|my-applications|my-games)/,
    );
  });

  it('dead game notices link to «my games»; closed by admin links to the game', () => {
    for (const kind of ['game.stale_reminder', 'game.dead', 'game.suspicious']) {
      expect(render(kind).text).toContain('Детальніше: https://nri.example/my-games');
    }
    expect(render('game.closed_by_admin').text).toContain(
      'Детальніше: https://nri.example/games/12',
    );
  });

  it('moderation: resolved complaint without details; digest with the count and the queue link', () => {
    const resolved = render('complaint.resolved', {});
    expect(resolved.text.split('\n')).toEqual([
      '🛡️ Твою скаргу розглянуто. Дякуємо, що допомагаєш зберігати спільноту безпечною!',
      '',
      'Детальніше: https://nri.example/',
    ]);
    expect(resolved.keyboard).toBeUndefined();
    const digest = render('moderation.digest', { count: 4 });
    expect(digest.text.split('\n')).toEqual([
      '🛡️ Нових скарг на розгляд: 4.',
      '',
      'Детальніше: https://nri.example/admin/complaints',
    ]);
  });

  it('sanctions: type, end date and reason; permanent without a date; lifted', () => {
    const imposed = render('sanction.imposed', {
      sanctionType: 'no_paid_apply',
      endsAt: '2026-12-02T10:00:00.000Z',
      reason: 'Неявка без попередження',
    });
    expect(imposed.text.split('\n')).toEqual([
      '⚠️ На твій акаунт накладено обмеження «заборона подаватися на платні ігри» до ср, 2 грудня о 12:00.',
      'Причина: Неявка без попередження',
      '',
      'Детальніше: https://nri.example/my-sanctions',
    ]);
    const permanent = render('sanction.imposed', {
      sanctionType: 'global_ban',
      endsAt: null,
      reason: 'Шахрайство',
    });
    expect(permanent.text).toContain('безстрокове обмеження «блокування акаунта»');
    expect(permanent.text).not.toContain('{');
    const lifted = render('sanction.lifted', { sanctionType: 'warning' });
    expect(lifted.text.split('\n')[0]).toBe('✅ Обмеження «попередження» з твого акаунта знято.');
  });

  it('appeal.decided: accepted / rejected with the note; link to my sanctions', () => {
    const accepted = render('appeal.decided', { sanctionType: 'global_ban', accepted: true });
    expect(accepted.text.split('\n')).toEqual([
      '✅ Твою апеляцію прийнято: обмеження «блокування акаунта» знято.',
      '',
      'Детальніше: https://nri.example/my-sanctions',
    ]);
    const rejected = render('appeal.decided', {
      sanctionType: 'warning',
      accepted: false,
      reason: 'Порушення підтверджено',
    });
    expect(rejected.text.split('\n').slice(0, 2)).toEqual([
      '❌ Твою апеляцію на обмеження «попередження» відхилено.',
      'Причина: Порушення підтверджено',
    ]);
    expect(render('appeal.decided', {}).text).toContain(
      'Твою апеляцію на обмеження «обмеження» розглянуто.',
    );
  });

  it('every NotificationType has a uk.json template', () => {
    for (const kind of NOTIFICATION_TYPES) {
      const [group, name] = kind.split('.') as [string, string];
      const g = (uk.notify as Record<string, unknown>)[group] as Record<string, unknown>;
      expect(typeof g[name], kind).toBe('string');
    }
  });

  it('rating.*: invitation texts, deadline line in the recipient zone, link to the rate page', () => {
    const closesAt = '2026-12-09T17:00:00.000Z'; // 19:00 за Києвом
    const session = render('rating.session_open', {
      gameId: 12,
      gameTitle: 'Гра',
      sessionId: 56,
      closesAt,
    });
    expect(session.text).toBe(
      [
        '⭐ Сесію гри «Гра» завершено — оціни тих, з ким грав(-ла).',
        `Оцінити можна до ${formatWhen(closesAt)}.`,
        '',
        'Детальніше: https://nri.example/games/12/rate?session=56',
      ].join('\n'),
    );
    expect(session.keyboard).toBeUndefined();
    const final = render('rating.final_open', { gameId: 12, gameTitle: 'Гра', closesAt });
    expect(final.text.split('\n')[0]).toBe('⭐ Час оцінити учасників гри «Гра».');
    expect(final.text).toContain('https://nri.example/games/12/rate');
    expect(final.text).not.toContain('?session=');
    // «Вихідна» оцінка, поки гра йде: без дедлайну — без рядка строку.
    const left = render('rating.member_left', {
      gameId: 12,
      gameTitle: 'Гра',
      ratee: { publicId: 'p9', nickname: 'Арагорн' },
    });
    expect(left.text).toBe(
      [
        '⭐ Арагорн більше не грає в «Гра» — можеш оцінити цього гравця.',
        '',
        'Детальніше: https://nri.example/games/12/rate',
      ].join('\n'),
    );
    const anon = render('rating.member_left', {
      gameId: 12,
      gameTitle: 'Гра',
      ratee: { publicId: 'p9', nickname: null },
    });
    expect(anon.text.split('\n')[0]).toContain(uk.notify.someone);
    const deadline = render('rating.deadline', { gameId: 12, gameTitle: 'Гра', closesAt }, null);
    expect(deadline.text.split('\n')[0]).toBe(
      '⏳ Вікно оцінювання в грі «Гра» скоро закриється — ще встигнеш оцінити тих, з ким грав(-ла).',
    );
    expect(deadline.text).toContain(`Оцінити можна до ${formatWhen(closesAt)}.`);
    const startsAt = '2026-11-27T17:00:00.000Z';
    const sessionDeadline = render('rating.deadline', {
      gameId: 12,
      gameTitle: 'Гра',
      sessionId: 56,
      startsAt,
      closesAt,
    });
    expect(sessionDeadline.text.split('\n')[0]).toBe(
      `⏳ Вікно оцінювання сесії ${formatWhen(startsAt)} у грі «Гра» скоро закриється — ще встигнеш оцінити тих, з ким грав(-ла).`,
    );
    expect(sessionDeadline.text).toContain('https://nri.example/games/12/rate?session=56');
    expect(
      renderNotification('rating.deadline', { gameId: 12, closesAt }, null, {
        siteUrl: SITE,
        timeZone: 'Asia/Tokyo',
      }).text,
    ).toContain(`до ${formatWhen(closesAt, 'Asia/Tokyo')}`);
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

  it('campaign pause: reason and note; resume with the first session in the recipient zone; recruit variant; long pause', () => {
    const p = render('game.paused', { ...base, pauseReason: 'vacation', note: 'До березня' });
    expect(p.text.split('\n').slice(0, 2)).toEqual([
      uk.notify.game.paused.replace('{game}', 'Прокляття Страда'),
      'Причина: відпустка — До березня',
    ]);
    expect(render('game.paused', { ...base, pauseReason: 'illness', note: null }).text).toContain(
      'Причина: хвороба\n',
    );
    expect(render('game.paused', { ...base }).text).not.toContain('Причина');

    const ny = renderNotification('game.resumed', { ...base, recruit: false }, null, {
      siteUrl: SITE,
      timeZone: 'America/New_York',
    });
    expect(ny.text.split('\n')[0]).toBe(
      '▶️ Кампейн «Прокляття Страда» продовжується! Перша сесія — пт, 27 листопада о 12:00.',
    );
    expect(ny.text).toContain('Детальніше: https://nri.example/games/12');
    expect(render('game.resumed', { ...base, recruit: true }).text).toContain('донабір');
    expect(render('game.resumed', { ...base, recruit: false }).text).not.toContain('донабір');

    const long = render('game.long_pause');
    expect(long.text).toContain('понад 90 днів');
    expect(long.text).toContain('Детальніше: https://nri.example/games/12');
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
    expect(r.text).toContain(uk.notify.unknownGame);
    expect(render('session.cancelled', { gameId: 1 }).text).toContain(uk.notify.unknownTime);
  });

  it('withdrawn / left without an actor use the _noactor variants', () => {
    const w = render('application.withdrawn', { gameId: 1, gameTitle: 'Гра' });
    expect(w.text.split('\n')[0]).toBe('↩️ Заявку на гру «Гра» відкликано.');
    const l = render('member.left', { gameId: 1, gameTitle: 'Гра' });
    expect(l.text.split('\n')[0]).toBe('🚪 Гравець покидає гру «Гра».');
    expect(w.text + l.text).not.toContain(uk.notify.someone);
    // Причина account_deleted має перевагу над _noactor.
    expect(
      render('member.left', { gameId: 1, gameTitle: 'Гра', reason: 'account_deleted' }).text,
    ).toContain('акаунт видалено');
  });

  it('application.created without an actor drops "від …"', () => {
    const r = render('application.created', { gameId: 1, gameTitle: 'Гра' });
    expect(r.text.split('\n')[0]).toBe('📜 Нова заявка на гру «Гра».');
    expect(r.text).not.toContain(uk.notify.someone);
  });

  it('reminder without an offset has no double space', () => {
    const r = render('session.reminder', {
      gameId: 1,
      gameTitle: 'Гра',
      sessionId: 2,
      startsAt: '2026-11-28T17:00:00.000Z',
    });
    expect(r.text).not.toMatch(/ {2}/);
    expect(r.text.split('\n')[0]).toBe(
      '⏰ Нагадування: сесія гри «Гра» — сб, 28 листопада о 19:00.',
    );
  });

  it('uses the recipient time zone; an invalid zone falls back to Kyiv', () => {
    const p = { gameId: 1, gameTitle: 'Гра', startsAt: '2026-11-28T17:00:00.000Z' };
    const ny = renderNotification('session.cancelled', p, null, {
      siteUrl: 'https://s',
      timeZone: 'America/New_York',
    });
    expect(ny.text).toContain('о 12:00');
    const bad = renderNotification('session.cancelled', p, null, {
      siteUrl: 'https://s',
      timeZone: 'Not/AZone',
    });
    expect(bad.text).toContain('о 19:00');
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
