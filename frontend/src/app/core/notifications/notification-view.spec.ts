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
      const key = notificationView(dto(type), 'Europe/Kyiv').key;
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
