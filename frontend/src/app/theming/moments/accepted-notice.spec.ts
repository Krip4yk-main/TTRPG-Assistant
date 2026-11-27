import { TestBed } from '@angular/core/testing';
import type { NotificationDto } from '@nri/shared';
import { TEST_NOW } from '../../../testing/test-now';
import { ACCEPTED_NOTICE_STORAGE_KEY, AcceptedNoticeMoment } from './accepted-notice';

const notice = (id: number, over: Partial<NotificationDto> = {}): NotificationDto =>
  ({
    id,
    type: 'application.approved',
    params: {},
    link: '/games/1',
    readAt: null,
    createdAt: new Date(TEST_NOW).toISOString(),
    ...over,
  }) as NotificationDto;

describe('AcceptedNoticeMoment', () => {
  beforeEach(() => localStorage.removeItem(ACCEPTED_NOTICE_STORAGE_KEY));
  afterEach(() => localStorage.removeItem(ACCEPTED_NOTICE_STORAGE_KEY));

  const fresh = () => {
    TestBed.resetTestingModule();
    return TestBed.inject(AcceptedNoticeMoment);
  };

  it('кандидати — лише непрочитані «вас прийнято», у тому ж порядку', () => {
    const m = fresh();
    const got = m.candidates([
      notice(4),
      notice(1),
      notice(2, { readAt: new Date(TEST_NOW).toISOString() }),
      notice(3, { type: 'application.rejected' }),
    ]);
    expect(got.map((n) => n.id)).toEqual([4, 1]);
  });

  it('candidates нічого не позначає', () => {
    const m = fresh();
    expect(m.candidates([notice(1)])).toHaveLength(1);
    expect(m.candidates([notice(1)])).toHaveLength(1);
    expect(localStorage.getItem(ACCEPTED_NOTICE_STORAGE_KEY)).toBeNull();
    expect(fresh().candidates([notice(1)])).toHaveLength(1);
  });

  it('markPlayed — один раз на сповіщення, і після перезавантаження', () => {
    const m = fresh();
    m.markPlayed(1);
    expect(m.candidates([notice(2), notice(1)]).map((n) => n.id)).toEqual([2]);
    m.markPlayed(1);
    expect(JSON.parse(localStorage.getItem(ACCEPTED_NOTICE_STORAGE_KEY)!)).toEqual([1]);
    const again = fresh();
    expect(again.candidates([notice(1)])).toHaveLength(0);
    expect(again.candidates([notice(2)]).map((n) => n.id)).toEqual([2]);
  });

  it('пошкоджене сховище — як порожнє', () => {
    localStorage.setItem(ACCEPTED_NOTICE_STORAGE_KEY, '{oops');
    expect(fresh().candidates([notice(1)])).toHaveLength(1);
  });
});
