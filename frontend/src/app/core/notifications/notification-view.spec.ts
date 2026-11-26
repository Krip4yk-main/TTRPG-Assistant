import { NOTIFICATION_TYPES, type NotificationDto, type NotificationType } from '@nri/shared';
import uk from '../../../assets/i18n/uk.json';
import {
  ACCOUNT_DELETED_VARIANTS,
  ANONYMOUS_VARIANTS,
  NOTIFICATION_REASON_CODES,
  THANKS_GENRES,
  notificationTime,
  notificationView,
} from './notification-view';

const lookup = (key: string): unknown =>
  key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      uk,
    );

const dto = (type: NotificationType, params: NotificationDto['params'] = {}): NotificationDto => ({
  id: 1,
  type,
  category: 'games',
  params: { gameId: 1, gameTitle: 'Гра', actor: { publicId: 'p', nickname: 'Фродо' }, ...params },
  link: '/games/1',
  createdAt: '2026-11-25T10:00:00.000Z',
  readAt: null,
});

describe('notificationView', () => {
  it('every NOTIFICATION_TYPE has a translation (and every account_deleted variant)', () => {
    const missing: string[] = [];
    for (const type of NOTIFICATION_TYPES) {
      // `endsAt` — строкова санкція (безстрокова має окремий текст `_permanent`).
      const key = notificationView(
        dto(type, { endsAt: '2026-12-02T10:00:00.000Z' }),
        'Europe/Kyiv',
      ).key;
      expect(key).toBe(`notifications.${type}`);
      if (typeof lookup(key) !== 'string') missing.push(key);
      const deleted = notificationView(dto(type, { reason: 'account_deleted' }), 'Europe/Kyiv');
      if (typeof lookup(deleted.key) !== 'string') missing.push(deleted.key);
    }
    expect(missing).toEqual([]);
    for (const type of ANONYMOUS_VARIANTS) {
      const key = notificationView(dto(type, { actor: null }), 'UTC').key;
      expect(key).toBe(`notifications.${type}_anonymous`);
      expect(lookup(key)).toEqual(expect.any(String));
      expect(lookup(key)).not.toContain('{{actor}}');
    }
    // Без автора в інших типах текст не містить {{actor}} — варіант не потрібен.
    for (const type of NOTIFICATION_TYPES) {
      if (ANONYMOUS_VARIANTS.includes(type)) continue;
      expect(lookup(`notifications.${type}`)).not.toContain('{{actor}}');
    }
    for (const type of ACCOUNT_DELETED_VARIANTS) {
      expect(notificationView(dto(type, { reason: 'account_deleted' }), 'UTC').key).toBe(
        `notifications.${type}_account_deleted`,
      );
    }
  });

  it('reason codes, offsets, thanks and helper texts are translated', () => {
    for (const code of NOTIFICATION_REASON_CODES) {
      expect(lookup(`notifications.reasons.${code}`)).toEqual(expect.any(String));
    }
    for (const offset of [15, 60, 180, 1440, 2880]) {
      const v = notificationView(dto('session.reminder', { offsetMin: offset }), 'UTC');
      expect(lookup(v.offset!.key)).toEqual(expect.any(String));
    }
    expect(notificationView(dto('session.reminder', { offsetMin: 7 }), 'UTC').offset).toEqual({
      key: 'notifications.offset.other',
      params: { n: 7 },
    });
    const thanks = uk.notifications.thanks as Record<string, string>;
    expect(Object.keys(thanks).sort()).toEqual([...THANKS_GENRES, 'default'].sort());
    for (const text of Object.values(thanks)) expect(text).not.toMatch(/донат|підтрима|monobank/i);
    // Жанри каталогу збігаються з подяками.
    expect(Object.keys(uk.genres).sort()).toEqual([...THANKS_GENRES].sort());
    for (const k of ['unknownGame', 'unknownTime', 'someone', 'generic', 'reason']) {
      expect(lookup(`notifications.${k}`)).toEqual(expect.any(String));
    }
  });

  it('game.finished: genre thank-you with default fallback', () => {
    expect(notificationView(dto('game.finished', { genreSlug: 'noir' }), 'UTC').thanksKey).toBe(
      'notifications.thanks.noir',
    );
    expect(notificationView(dto('game.finished', { genreSlug: 'x' }), 'UTC').thanksKey).toBe(
      'notifications.thanks.default',
    );
    expect(notificationView(dto('game.finished'), 'UTC').thanksKey).toBe(
      'notifications.thanks.default',
    );
    expect(notificationView(dto('game.started'), 'UTC').thanksKey).toBeNull();
  });

  it('null actor / title fall back; dates use the viewer time zone; free-text reason', () => {
    const v = notificationView(
      dto('session.cancelled', {
        gameTitle: null,
        actor: null,
        startsAt: '2026-11-25T17:00:00.000Z',
        reason: 'Захворів',
      }),
      'Europe/Kyiv',
    );
    expect(v.game).toBeNull();
    expect(v.actor).toBeNull();
    expect(v.when).toContain('19:00');
    expect(v.reason).toEqual({ code: null, text: 'Захворів' });

    const left = notificationView(dto('session.cancelled', { reason: 'account_deleted' }), 'UTC');
    expect(left.reason).toEqual({ code: 'account_deleted', text: null });
  });

  it('campaign pause: reason code + note; resume date in the viewer zone without a zone label; recruit variant', () => {
    const paused = notificationView(
      dto('game.paused', { pauseReason: 'study_work', note: 'Сесія' }),
      'Europe/Kyiv',
    );
    expect(paused.key).toBe('notifications.game.paused');
    expect(paused.reason).toEqual({ code: 'pause.study_work', text: 'Сесія' });
    expect(lookup('notifications.reasons.pause.study_work')).toBe('навчання чи робота');
    for (const r of ['vacation', 'illness', 'study_work', 'other']) {
      expect(typeof lookup(`notifications.reasons.pause.${r}`)).toBe('string');
    }
    expect(
      notificationView(dto('game.paused', { pauseReason: 'vacation', note: null }), 'UTC').reason,
    ).toEqual({ code: 'pause.vacation', text: null });

    const startsAt = '2026-11-27T17:00:00.000Z';
    const resumed = notificationView(
      dto('game.resumed', { startsAt, recruit: false }),
      'America/New_York',
    );
    expect(resumed.key).toBe('notifications.game.resumed');
    expect(resumed.when).toContain('12:00');
    expect(resumed.when).not.toMatch(/GMT|EST|UTC/);
    const recruit = notificationView(dto('game.resumed', { startsAt, recruit: true }), 'UTC');
    expect(recruit.key).toBe('notifications.game.resumed_recruit');
    expect(String(lookup('notifications.game.resumed_recruit'))).toContain('донабір');
  });

  it('rsvp declined: one member vs «X та ще N»; calendar reminder explains can/cannot/unknown', () => {
    expect(notificationView(dto('session.rsvp_declined', { count: 0 }), 'UTC').key).toBe(
      'notifications.session.rsvp_declined',
    );
    const many = notificationView(dto('session.rsvp_declined', { count: 2 }), 'UTC');
    expect(many.key).toBe('notifications.session.rsvp_declined_many');
    expect(many.count).toBe(2);
    expect(String(lookup(many.key))).toContain('{{count}}');
    const cal = String(lookup('notifications.calendar.empty'));
    expect(cal).toContain('можете, не можете, чи це невідомо');
    const imported = notificationView(dto('calendar.empty', { hasImport: true }), 'UTC');
    expect(imported.key).toBe('notifications.calendar.empty_imported');
    expect(String(lookup(imported.key))).toContain('звичні години');
  });

  it('schedule notifications: own icons, translated texts for every new type', () => {
    const icon = (type: NotificationType) =>
      notificationView({ ...dto(type), category: 'schedule' }, 'UTC').icon;
    expect(icon('poll.created')).toBe('how_to_vote');
    expect(icon('poll.closed')).toBe('how_to_vote');
    expect(icon('session.rsvp_declined')).toBe('event_busy');
    expect(icon('calendar.empty')).toBe('edit_calendar');
    expect(icon('calendar.import_broken')).toBe('sync_problem');
    for (const type of [
      'poll.created',
      'poll.closed',
      'session.created',
      'calendar.empty',
      'calendar.import_broken',
    ] as const) {
      expect(typeof lookup('notifications.' + type)).toBe('string');
    }
  });

  it('long pause reminder: text names the three choices; quick actions link to the game page', () => {
    const v = notificationView(dto('game.long_pause'), 'UTC');
    expect(v.key).toBe('notifications.game.long_pause');
    const text = String(lookup('notifications.game.long_pause'));
    expect(text).toContain('відновити');
    expect(text).toContain('донабір');
    expect(text).toContain('завершити');
    expect(v.actions).toEqual([
      { labelKey: 'games.actions.resume', action: 'resume' },
      { labelKey: 'games.actions.recruit', action: 'recruit' },
      { labelKey: 'games.pause.panel.finish', action: 'finish' },
    ]);
    for (const a of v.actions) expect(typeof lookup(a.labelKey)).toBe('string');
    // Інші сповіщення — без швидких дій.
    expect(notificationView(dto('game.paused'), 'UTC').actions).toEqual([]);
  });

  it('rating.*: ratee name, deadline in the viewer zone only with closesAt', () => {
    const left = notificationView(
      dto('rating.member_left', { ratee: { publicId: 'r', nickname: 'Арвен' } }),
      'Europe/Kyiv',
    );
    expect(left.key).toBe('notifications.rating.member_left');
    expect(left.ratee).toBe('Арвен');
    expect(left.closes).toBeNull();
    expect(
      notificationView(
        dto('rating.member_left', { ratee: { publicId: 'r', nickname: null } }),
        'UTC',
      ).ratee,
    ).toBeNull();
    const deadline = notificationView(
      dto('rating.deadline', { sessionId: 3, closesAt: '2026-12-09T17:00:00.000Z' }),
      'Europe/Kyiv',
    );
    expect(deadline.closes).toContain('19:00');
    // Без дати сесії — загальний текст; з датою сесії — варіант «сесії {{when}}».
    expect(deadline.key).toBe('notifications.rating.deadline');
    const sessionDeadline = notificationView(
      dto('rating.deadline', {
        sessionId: 3,
        startsAt: '2026-11-25T17:00:00.000Z',
        closesAt: '2026-12-09T17:00:00.000Z',
      }),
      'Europe/Kyiv',
    );
    expect(sessionDeadline.key).toBe('notifications.rating.deadline_session');
    expect(sessionDeadline.when).toContain('19:00');
    expect(lookup('notifications.rating.deadline_session')).toContain('{{when}}');
    expect(lookup('notifications.rating.member_left')).toContain('оцінити цього гравця');
    expect(lookup('notifications.rating.until')).toContain('{{closes}}');
    expect(lookup('notifications.categories.ratings.label')).toEqual(expect.any(String));
    expect(lookup('notifications.categories.ratings.hint')).toEqual(expect.any(String));
    // closesAt в інших типах ігнорується.
    expect(
      notificationView(dto('game.started', { closesAt: '2026-12-09T17:00:00.000Z' }), 'UTC').closes,
    ).toBeNull();
  });

  it('moderation: resolved complaint has no details; digest carries the count; shield icon', () => {
    const resolved = notificationView(
      { ...dto('complaint.resolved'), category: 'moderation', params: {} },
      'UTC',
    );
    expect(resolved.key).toBe('notifications.complaint.resolved');
    expect(resolved.icon).toBe('shield');
    expect(lookup(resolved.key)).not.toMatch(/\{\{/);
    const digest = notificationView(
      { ...dto('moderation.digest'), category: 'moderation', params: { count: 3 } },
      'UTC',
    );
    expect(digest.key).toBe('notifications.moderation.digest');
    expect(digest.count).toBe(3);
    expect(lookup(digest.key)).toContain('{{count}}');
    expect(lookup('notifications.categories.moderation.label')).toBe('Модерація');
    expect(lookup('notifications.categories.moderation.hint')).toEqual(expect.any(String));
  });

  it('appeal.decided: accepted/rejected texts with the sanction type and the note', () => {
    const accepted = notificationView(
      {
        ...dto('appeal.decided'),
        category: 'moderation',
        params: { sanctionType: 'global_ban', accepted: true },
      },
      'UTC',
    );
    expect(accepted.key).toBe('notifications.appeal.decided_accepted');
    expect(accepted.sanction).toBe('notifications.sanction.types.global_ban');
    expect(accepted.reason).toBeNull();
    expect(lookup(accepted.key)).toContain('{{sanction}}');
    const rejected = notificationView(
      {
        ...dto('appeal.decided'),
        category: 'moderation',
        params: { sanctionType: 'warning', accepted: false, reason: 'Підтверджено' },
      },
      'UTC',
    );
    expect(rejected.key).toBe('notifications.appeal.decided_rejected');
    expect(rejected.reason).toEqual({ code: null, text: 'Підтверджено' });
    expect(lookup(rejected.key)).toEqual(expect.any(String));
  });

  it('sanctions: type name, end date, reason; permanent variant; lifted without reason', () => {
    const imposed = notificationView(
      {
        ...dto('sanction.imposed'),
        category: 'moderation',
        params: {
          sanctionType: 'no_paid_apply',
          endsAt: '2026-12-02T10:00:00.000Z',
          reason: 'Неявка без попередження',
        },
      },
      'Europe/Kyiv',
    );
    expect(imposed.key).toBe('notifications.sanction.imposed');
    expect(imposed.sanction).toBe('notifications.sanction.types.no_paid_apply');
    expect(lookup(imposed.sanction!)).toBe('заборона подаватися на платні ігри');
    expect(imposed.until).toEqual(expect.stringContaining('12:00'));
    expect(imposed.reason).toEqual({ code: null, text: 'Неявка без попередження' });
    expect(lookup(imposed.key)).toContain('{{until}}');

    const permanent = notificationView(
      {
        ...dto('sanction.imposed'),
        category: 'moderation',
        params: { sanctionType: 'global_ban', endsAt: null, reason: 'Шахрайство' },
      },
      'UTC',
    );
    expect(permanent.key).toBe('notifications.sanction.imposed_permanent');
    expect(permanent.until).toBeNull();
    expect(lookup(permanent.key)).not.toContain('{{until}}');

    const lifted = notificationView(
      { ...dto('sanction.lifted'), category: 'moderation', params: { sanctionType: 'warning' } },
      'UTC',
    );
    expect(lifted.key).toBe('notifications.sanction.lifted');
    expect(lifted.reason).toBeNull();
    for (const t of [
      'warning',
      'application_limit',
      'no_paid_apply',
      'no_paid_create',
      'global_ban',
      'unknown',
    ]) {
      expect(lookup(`notifications.sanction.types.${t}`)).toEqual(expect.any(String));
    }
  });

  it('unknown type renders the generic text', () => {
    const v = notificationView(
      { ...dto('game.started'), type: 'future.thing' as NotificationType },
      'UTC',
    );
    expect(v.key).toBe('notifications.generic');
  });

  it('notificationTime: just now, relative within a week, date after', () => {
    const now = Date.parse('2026-11-25T12:00:00.000Z');
    expect(notificationTime('2026-11-25T11:59:30.000Z', 'UTC', now).justNow).toBe(true);
    expect(notificationTime('2026-11-25T11:00:00.000Z', 'UTC', now).relative).toMatch(/годин/);
    expect(notificationTime('2026-11-01T11:00:00.000Z', 'UTC', now).relative).toBeNull();
  });
});
