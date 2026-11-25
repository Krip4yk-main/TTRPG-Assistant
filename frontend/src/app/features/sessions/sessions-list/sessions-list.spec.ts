import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MatDialog } from '@angular/material/dialog';
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

  async function create(isGm: boolean, manageable = true) {
    dialogOpen = vi.fn();
    changed = vi.fn<() => void>();
    await TestBed.configureTestingModule({
      imports: [SessionsList],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
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
    fixture.componentInstance.changed.subscribe(() => changed());
    el = fixture.nativeElement as HTMLElement;
    await settle();
    http.expectOne('/api/games/3/sessions').flush(all);
    await settle();
  }

  afterEach(() => http.verify());

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
});
