import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { of, Subject } from 'rxjs';
import type { MeDto, SessionDto } from '@nri/shared';
import { SessionsList } from './sessions-list';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';
import { formatDateTime } from '../../../core/i18n/dates';
import { FinishSessionDialog } from '../finish-session-dialog/finish-session-dialog';
import { RescheduleDialog } from '../session-actions/reschedule-dialog';
import { CancelSessionDialog } from '../session-actions/cancel-session-dialog';

const me = {
  id: 1,
  publicId: 'abcdefghjk',
  nickname: 'Frodo',
  avatarUrl: null,
  birthDate: '1990-01-01',
  role: 'user',
  status: 'active',
  timezone: 'Europe/Warsaw',
  locale: 'uk',
  identities: [],
} satisfies MeDto;

const base: SessionDto = {
  id: 0,
  gameId: 3,
  startsAt: '',
  durationMinutes: 180,
  status: 'scheduled',
  origin: 'rule',
  rescheduled: false,
  cancelReason: null,
  summary: null,
  doneAt: null,
  myRsvp: null,
  rsvpSummary: null,
  seen: 'seen',
};
const done: SessionDto = {
  ...base,
  id: 1,
  startsAt: '2026-11-01T17:00:00.000Z',
  status: 'done',
  summary: 'Знайшли карту',
  doneAt: '2026-11-01T21:00:00.000Z',
};
const started: SessionDto = { ...base, id: 2, startsAt: '2026-11-20T17:00:00.000Z' };
const upcoming: SessionDto = {
  ...base,
  id: 3,
  startsAt: '2027-03-02T17:00:00.000Z',
  rescheduled: true,
};
const cancelled: SessionDto = {
  ...base,
  id: 4,
  startsAt: '2027-03-09T17:00:00.000Z',
  status: 'cancelled',
  cancelReason: 'Майстер у відпустці',
};
const all = [done, started, upcoming, cancelled];

describe('SessionsList', () => {
  let fixture: ComponentFixture<SessionsList>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let dialogOpen: ReturnType<typeof vi.fn>;
  let changed: ReturnType<typeof vi.fn<() => void>>;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create(
    isGm: boolean,
    manageable = true,
    list: SessionDto[] = all,
    rateable = false,
  ) {
    dialogOpen = vi.fn();
    changed = vi.fn<() => void>();
    await TestBed.configureTestingModule({
      imports: [SessionsList],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        provideRouter([]),
        { provide: MatDialog, useValue: { open: dialogOpen } },
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            on: () => new Subject(),
            sessionLost$: new Subject(),
          },
        },
      ],
    }).compileComponents();
    TestBed.inject(AuthStore).setMe(me);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(SessionsList);
    fixture.componentRef.setInput('gameId', 3);
    fixture.componentRef.setInput('timezone', 'Europe/Kyiv');
    fixture.componentRef.setInput('isGm', isGm);
    fixture.componentRef.setInput('manageable', manageable);
    fixture.componentRef.setInput('rateable', rateable);
    fixture.componentInstance.changed.subscribe(() => changed());
    el = fixture.nativeElement as HTMLElement;
    await settle();
    http.expectOne('/api/games/3/sessions').flush(list);
    await settle();
  }

  afterEach(() => http.verify());

  describe('rate link', () => {
    const day = 24 * 60 * 60 * 1000;
    const recent: SessionDto = {
      ...done,
      id: 7,
      startsAt: new Date(Date.now() - 2 * day).toISOString(),
      doneAt: new Date(Date.now() - 2 * day + 3 * 60 * 60 * 1000).toISOString(),
    };
    const old: SessionDto = {
      ...done,
      id: 8,
      startsAt: new Date(Date.now() - 20 * day).toISOString(),
      doneAt: new Date(Date.now() - 15 * day).toISOString(),
    };
    const rateLink = (id: number) => row(id)!.querySelector<HTMLAnchorElement>('a.rate-link');

    it('done campaign session within 14 days links to the session rating page', async () => {
      await create(false, true, [recent, old, upcoming], true);
      expect(rateLink(7)!.getAttribute('href')).toBe('/games/3/rate?session=7');
      expect(rateLink(7)!.getAttribute('aria-label')).toBe('ratings.sessionLinkAria');
      // Вікно минуло, і майбутня сесія — без посилання; запитів цілей на кожну сесію немає.
      expect(rateLink(8)).toBeNull();
      expect(rateLink(3)).toBeNull();
      http.expectNone((r) => r.url.includes('/ratings'));
    });

    it('the GM gets the link too; a oneshot (not rateable) does not', async () => {
      await create(true, true, [recent], true);
      expect(rateLink(7)).not.toBeNull();
      TestBed.resetTestingModule();
      await create(false, true, [recent], false);
      expect(rateLink(7)).toBeNull();
    });
  });

  const row = (id: number) => el.querySelector<HTMLElement>(`[data-session-id="${id}"]`);
  const buttons = (id: number) =>
    [...row(id)!.querySelectorAll<HTMLButtonElement>('button[data-action]')].map(
      (b) => b.dataset['action'],
    );

  it('splits upcoming and past, marks rescheduled, shows reasons and summaries', async () => {
    await create(false);
    const upcomingIds = [...el.querySelectorAll('.upcoming [data-session-id]')].map((n) =>
      n.getAttribute('data-session-id'),
    );
    const pastIds = [...el.querySelectorAll('.past [data-session-id]')].map((n) =>
      n.getAttribute('data-session-id'),
    );
    expect(upcomingIds).toEqual(['3', '4']);
    // Минулі — від найновішої.
    expect(pastIds).toEqual(['2', '1']);
    expect(row(3)!.querySelector('.rescheduled')).not.toBeNull();
    expect(row(4)!.textContent).toContain('Майстер у відпустці');
    expect(row(4)!.querySelector('.status')!.getAttribute('data-status')).toBe('cancelled');
    expect(row(1)!.textContent).toContain('Знайшли карту');
    expect(el.querySelector('button[data-action]')).toBeNull();
  });

  it('times are in the viewer zone, labelled when it differs from the game zone', async () => {
    await create(false);
    const expected = formatDateTime(upcoming.startsAt, 'Europe/Warsaw', { showZone: true });
    expect(row(3)!.querySelector('time')!.textContent!.trim()).toBe(expected);
    expect(row(3)!.querySelector('time')!.getAttribute('datetime')).toBe(upcoming.startsAt);
  });

  it('the GM can finish only sessions that already started', async () => {
    await create(true);
    expect(buttons(2)).toEqual(['reschedule', 'cancel', 'finish']);
    expect(buttons(3)).toEqual(['reschedule', 'cancel']);
    expect(buttons(1)).toEqual([]);
    expect(buttons(4)).toEqual([]);
  });

  it('a finished or cancelled game offers no session actions', async () => {
    await create(true, false);
    expect(el.querySelector('button[data-action]')).toBeNull();
    // Незавершена минула сесія вже не «очікує завершення».
    expect(row(2)!.querySelector('.status')!.textContent).toContain('sessions.status.unfinished');
  });

  it('a started session of a running game awaits finishing', async () => {
    await create(false);
    expect(row(2)!.querySelector('.status')!.textContent).toContain('sessions.status.awaiting');
  });

  it('system cancel reasons are translated, GM reasons shown as typed', async () => {
    await create(false);
    const reload = fixture.componentInstance.reload();
    http
      .expectOne('/api/games/3/sessions')
      .flush([
        { ...cancelled, id: 5, cancelReason: 'rule_changed' },
        { ...cancelled, id: 6, cancelReason: 'game_finished' },
        cancelled,
      ]);
    await reload;
    await settle();
    expect(row(5)!.querySelector('.reason')!.textContent).toContain(
      'sessions.systemReason.rule_changed',
    );
    expect(row(6)!.querySelector('.reason')!.textContent).toContain(
      'sessions.systemReason.game_finished',
    );
    expect(row(4)!.querySelector('.reason')!.textContent).toContain('Майстер у відпустці');
  });

  it('finish opens the dialog; afterwards the list reloads and the row gets focus', async () => {
    await create(true);
    dialogOpen.mockReturnValueOnce({
      afterClosed: () => of({ ...started, status: 'done' }),
    });
    row(2)!.querySelector<HTMLButtonElement>('button[data-action="finish"]')!.click();
    await settle();
    expect(dialogOpen).toHaveBeenCalledWith(
      FinishSessionDialog,
      expect.objectContaining({ data: expect.objectContaining({ sessionId: 2, gameId: 3 }) }),
    );
    http.expectOne('/api/games/3/sessions').flush([done, { ...started, status: 'done' }]);
    await settle();
    await settle();
    expect(row(2)!.querySelector('.status')!.getAttribute('data-status')).toBe('done');
    expect(el.textContent).toContain('sessions.done.finish');
    expect(changed).toHaveBeenCalled();
    expect(document.activeElement).toBe(row(2));
  });

  it('reschedule and cancel pass the game zone; a dismissed dialog changes nothing', async () => {
    await create(true);
    dialogOpen.mockReturnValueOnce({ afterClosed: () => of(undefined) });
    row(3)!.querySelector<HTMLButtonElement>('button[data-action="reschedule"]')!.click();
    await settle();
    expect(dialogOpen).toHaveBeenCalledWith(
      RescheduleDialog,
      expect.objectContaining({
        data: expect.objectContaining({ timezone: 'Europe/Kyiv', viewerTimezone: 'Europe/Warsaw' }),
      }),
    );
    http.expectNone('/api/games/3/sessions');
    expect(changed).not.toHaveBeenCalled();

    dialogOpen.mockReturnValueOnce({ afterClosed: () => of({ ...upcoming, status: 'cancelled' }) });
    row(3)!.querySelector<HTMLButtonElement>('button[data-action="cancel"]')!.click();
    await settle();
    expect(dialogOpen).toHaveBeenLastCalledWith(CancelSessionDialog, expect.anything());
    http.expectOne('/api/games/3/sessions').flush(all);
    await settle();
    await settle();
    expect(el.textContent).toContain('sessions.done.cancel');
  });
  describe('a live clock', () => {
    afterEach(() => vi.useRealTimers());

    it('moves a session to the past once it starts and lets the GM finish it', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      vi.setSystemTime(new Date('2027-03-02T16:59:30.000Z'));
      await create(true);
      expect(row(3)!.closest('.upcoming')).not.toBeNull();
      expect(buttons(3)).toEqual(['reschedule', 'cancel']);

      vi.advanceTimersByTime(60_000);
      await settle();
      expect(row(3)!.closest('.past')).not.toBeNull();
      expect(row(3)!.querySelector('.status')!.textContent).toContain('sessions.status.awaiting');
      expect(buttons(3)).toEqual(['reschedule', 'cancel', 'finish']);
    });

    it('stops the clock when destroyed', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      await create(false);
      expect(vi.getTimerCount()).toBe(1);
      fixture.destroy();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('session note', () => {
    const toggle = (id: number) => row(id)!.querySelector<HTMLButtonElement>('button.note-toggle')!;

    it('expands inline, loads the private note and collapses again', async () => {
      await create(false);
      expect(toggle(3).getAttribute('aria-expanded')).toBe('false');
      expect(row(3)!.querySelector('nri-note-editor')).toBeNull();

      toggle(3).click();
      await settle();
      expect(toggle(3).getAttribute('aria-expanded')).toBe('true');
      const panelId = toggle(3).getAttribute('aria-controls')!;
      expect(row(3)!.querySelector(`#${panelId} nri-note-editor`)).not.toBeNull();
      http
        .expectOne('/api/sessions/3/notes/private')
        .flush({ body: 'Взяти кості', version: 1, updatedAt: '2026-11-20T10:00:00.000Z' });
      await settle();
      expect(row(3)!.querySelector('textarea')!.value).toBe('Взяти кості');

      toggle(3).click();
      await settle();
      expect(row(3)!.querySelector('nri-note-editor')).toBeNull();
    });
  });

  describe('RSVP', () => {
    const option = (id: number, st: string) =>
      row(id)!.querySelector<HTMLButtonElement>(`button[data-rsvp="${st}"]`);

    it('a member answers future scheduled sessions only; optimistic with aria-pressed', async () => {
      await create(false);
      expect(option(3, 'going')).not.toBeNull();
      // Скасована, минула й та, що вже почалась, — без RSVP.
      expect(row(4)!.querySelector('.rsvp')).toBeNull();
      expect(row(2)!.querySelector('.rsvp')).toBeNull();
      expect(row(1)!.querySelector('.rsvp')).toBeNull();
      expect(option(3, 'going')!.getAttribute('aria-pressed')).toBe('false');

      const mutated = vi.fn();
      fixture.componentInstance.mutated.subscribe(mutated);
      option(3, 'going')!.click();
      await settle();
      expect(mutated).toHaveBeenCalledTimes(1);
      // Вибір показано ще до відповіді сервера.
      expect(option(3, 'going')!.getAttribute('aria-pressed')).toBe('true');
      const req = http.expectOne('/api/sessions/3/rsvp');
      expect(req.request.method).toBe('PUT');
      expect(req.request.body).toEqual({ status: 'going' });
      req.flush({ ...upcoming, myRsvp: 'going' });
      await settle();
      // Ще раз після успіху — щоб тиша накрила й пізній власний пінг.
      expect(mutated).toHaveBeenCalledTimes(2);
      expect(option(3, 'going')!.getAttribute('aria-pressed')).toBe('true');
      expect(option(3, 'not_going')!.getAttribute('aria-pressed')).toBe('false');
      expect(el.querySelector('.message-area')!.textContent).toContain('sessions.rsvp.saved.going');
    });

    it('rolls back and shows the translated error on failure', async () => {
      await create(false, true, [{ ...upcoming, myRsvp: 'going' }]);
      option(3, 'not_going')!.click();
      await settle();
      expect(option(3, 'not_going')!.getAttribute('aria-pressed')).toBe('true');
      http
        .expectOne('/api/sessions/3/rsvp')
        .flush(
          { error: { code: 'SESSION_INVALID_STATE', message: 'x' } },
          { status: 409, statusText: 'Conflict' },
        );
      await settle();
      expect(option(3, 'going')!.getAttribute('aria-pressed')).toBe('true');
      expect(option(3, 'not_going')!.getAttribute('aria-pressed')).toBe('false');
      expect(el.querySelector('.message-area [role="alert"]')!.textContent).toContain(
        'errors.SESSION_INVALID_STATE',
      );
    });

    it('the GM gets no RSVP buttons but a summary with an expandable member list', async () => {
      const summary = {
        going: 1,
        notGoing: 1,
        members: [
          { publicId: 'aaaaaaaaaa', nickname: 'Сем', status: 'going' as const },
          { publicId: 'bbbbbbbbbb', nickname: 'Піпін', status: 'not_going' as const },
          { publicId: 'cccccccccc', nickname: 'Мері', status: null },
        ],
      };
      await create(true, true, [{ ...upcoming, rsvpSummary: summary }]);
      expect(row(3)!.querySelector('.rsvp')).toBeNull();
      const toggle = row(3)!.querySelector<HTMLButtonElement>('.summary-toggle')!;
      expect(toggle.textContent).toContain('sessions.rsvp.summary');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      const list = row(3)!.querySelector<HTMLElement>('.rsvp-list')!;
      expect(list.hidden).toBe(true);
      toggle.click();
      await settle();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(list.hidden).toBe(false);
      const states = [...list.querySelectorAll('li')].map((li) => li.getAttribute('data-rsvp'));
      expect(states).toEqual(['going', 'not_going', 'none']);
      expect(list.textContent).toContain('Мері');
    });
  });

  describe('badges', () => {
    it('a member sees «new»/«updated» and the sessions are marked viewed', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await create(false, true, [
          { ...upcoming, seen: 'new' },
          { ...cancelled, seen: 'updated' },
          { ...done, seen: 'seen' },
        ]);
        expect(row(3)!.querySelector('.nri-seen-badge')!.getAttribute('data-seen')).toBe('new');
        expect(row(4)!.querySelector('.nri-seen-badge')!.getAttribute('data-seen')).toBe('updated');
        expect(row(1)!.querySelector('.nri-seen-badge')).toBeNull();
        vi.runOnlyPendingTimers();
        const req = http.expectOne('/api/me/views');
        expect(req.request.body).toEqual({ entityType: 'session', ids: [3, 4] });
        req.flush(null);
      } finally {
        vi.useRealTimers();
      }
    });

    it('the GM sees no session badges and marks nothing', async () => {
      await create(true, true, [{ ...upcoming, seen: 'new' }]);
      expect(el.querySelector('.nri-seen-badge')).toBeNull();
      await new Promise((r) => setTimeout(r, 1600));
      http.expectNone('/api/me/views');
    });

    it('reload(true) highlights sessions that changed', async () => {
      await create(false, true, [upcoming, cancelled]);
      const p = fixture.componentInstance.reload(true);
      http
        .expectOne('/api/games/3/sessions')
        .flush([{ ...upcoming, durationMinutes: 240 }, cancelled]);
      await p;
      await settle();
      expect(row(3)!.classList).toContain('nri-flash');
      expect(row(4)!.classList).not.toContain('nri-flash');
    });
  });
});
