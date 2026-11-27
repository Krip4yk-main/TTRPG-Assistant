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

  it('лише непрочитані «вас прийнято»', () => {
    const m = fresh();
    const got = m.claim([
      notice(1),
      notice(2, { readAt: new Date(TEST_NOW).toISOString() }),
      notice(3, { type: 'application.rejected' }),
    ]);
    expect(got.map((n) => n.id)).toEqual([1]);
  });

  it('один раз на сповіщення — і після перезавантаження', () => {
    expect(fresh().claim([notice(1)])).toHaveLength(1);
    const m = fresh();
    expect(m.claim([notice(1)])).toHaveLength(0);
    expect(m.claim([notice(2), notice(1)]).map((n) => n.id)).toEqual([2]);
    expect(m.claim([notice(2)])).toHaveLength(0);
  });

  it('пошкоджене сховище — як порожнє', () => {
    localStorage.setItem(ACCEPTED_NOTICE_STORAGE_KEY, '{oops');
    expect(fresh().claim([notice(1)])).toHaveLength(1);
  });
});
