import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import type { SessionDto } from '@nri/shared';
import { RescheduleDialog, type RescheduleDialogData } from './reschedule-dialog';

const session: SessionDto = {
  id: 41,
  gameId: 3,
  startsAt: '2027-03-09T00:00:00.000Z',
  durationMinutes: 180,
  startWindowMinutes: null,
  status: 'scheduled',
  origin: 'rule',
  rescheduled: false,
  cancelReason: null,
  summary: null,
  summarySentAt: null,
  doneAt: null,
  myRsvp: null,
  rsvpSummary: null,
  seen: 'seen',
};

describe('RescheduleDialog', () => {
  let fixture: ComponentFixture<RescheduleDialog>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let close: ReturnType<typeof vi.fn>;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create(s: SessionDto = session) {
    close = vi.fn();
    const data: RescheduleDialogData = {
      session: s,
      timezone: 'America/New_York',
      viewerTimezone: 'Europe/Kyiv',
    };
    await TestBed.configureTestingModule({
      imports: [RescheduleDialog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(RescheduleDialog);
    el = fixture.nativeElement as HTMLElement;
    await settle();
  }

  beforeEach(async () => {
    await create();
  });

  afterEach(() => http.verify());

  const form = () => fixture.componentInstance['form'];
  const submit = async () => {
    el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settle();
  };

  it('prefills the current start as local time of the game zone', () => {
    // 2027-03-09T00:00Z = 8 березня, 19:00 у Нью-Йорку (EST, UTC−5).
    const v = form().getRawValue();
    expect([v.date!.getFullYear(), v.date!.getMonth() + 1, v.date!.getDate()]).toEqual([
      2027, 3, 8,
    ]);
    expect(v.time).toBe('19:00');
    expect(el.textContent).toContain('America/New_York');
  });

  it('converts the local game time to UTC (whole minute) and sends it', async () => {
    form().patchValue({ date: new Date(2027, 2, 10), time: '19:30', durationMinutes: 240 });
    await submit();
    const req = http.expectOne('/api/sessions/41/reschedule');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      startsAt: '2027-03-11T00:30:00.000Z',
      durationMinutes: 240,
    });
    const dto = { ...session, startsAt: '2027-03-11T00:30:00.000Z', rescheduled: true };
    req.flush(dto);
    await settle();
    expect(close).toHaveBeenCalledWith(dto);
  });

  it('after the DST switch the same local time maps to a different UTC hour', async () => {
    form().patchValue({ date: new Date(2027, 2, 20), time: '19:30' });
    await submit();
    const req = http.expectOne('/api/sessions/41/reschedule');
    // Тривалість не змінено — поле не надсилається.
    expect(req.request.body).toEqual({ startsAt: '2027-03-20T23:30:00.000Z' });
    req.flush(session);
    await settle();
  });

  it('a time in the past is rejected next to the field without a request', async () => {
    form().patchValue({ date: new Date(2020, 0, 1), time: '10:00' });
    await submit();
    http.expectNone('/api/sessions/41/reschedule');
    expect(el.textContent).toContain('sessions.reschedule.past');
    expect(close).not.toHaveBeenCalled();
  });

  it('approximate: sends the window start and its width', async () => {
    el.querySelector<HTMLElement>('.mode-approx button')!.click();
    await settle();
    form().patchValue({ date: new Date(2027, 2, 10), time: '18:00', startWindowMinutes: 120 });
    await submit();
    const req = http.expectOne('/api/sessions/41/reschedule');
    expect(req.request.body).toEqual({
      startsAt: '2027-03-10T23:00:00.000Z',
      startWindowMinutes: 120,
    });
    req.flush({ ...session, startWindowMinutes: 120 });
    await settle();
  });

  it('a window across midnight labels «to» as the next day', async () => {
    el.querySelector<HTMLElement>('.mode-approx button')!.click();
    await settle();
    form().patchValue({ time: '22:00' });
    await settle();
    const to = [...el.querySelectorAll<HTMLOptionElement>('select.window-to option')].map((o) =>
      o.textContent!.trim(),
    );
    // 22:30, 23:00, 23:30 — того ж дня; 00:00 і далі — наступного.
    expect(to.slice(0, 3)).toEqual(Array(3).fill('sessions.window.end'));
    expect(to[3]).toBe('sessions.window.endNextDay');
  });

  describe('windowed session whose window has started', () => {
    // «Зараз» — 10 бер. 2027, 15:10 у Нью-Йорку; вікно 14:00–16:00 почалось годину тому.
    const now = new Date('2027-03-10T20:10:00.000Z');
    const start = new Date('2027-03-10T19:00:00.000Z');
    const windowed = { ...session, startsAt: start.toISOString(), startWindowMinutes: 120 };

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
      TestBed.resetTestingModule();
      await create(windowed);
    });

    afterEach(() => vi.useRealTimers());

    it('pinning to a past moment inside the window is allowed', async () => {
      el.querySelector<HTMLElement>('.mode-exact button')!.click();
      await settle();
      expect(form().getRawValue().startWindowMinutes).toBeNull();
      // 14:30 — уже минуло, але в межах вікна.
      form().patchValue({ time: '14:30' });
      await submit();
      const req = http.expectOne('/api/sessions/41/reschedule');
      expect(req.request.body).toEqual({
        startsAt: '2027-03-10T19:30:00.000Z',
        startWindowMinutes: null,
      });
      req.flush({ ...windowed, startsAt: '2027-03-10T19:30:00.000Z', startWindowMinutes: null });
      await settle();
      expect(close).toHaveBeenCalled();
    });

    it('a window across midnight that started yesterday can be pinned to yesterday evening', async () => {
      // Вікно 9 бер. 22:00 – 10 бер. 04:00 (Нью-Йорк); «зараз» — 10 бер. 15:10, вже минуло.
      TestBed.resetTestingModule();
      await create({ ...session, startsAt: '2027-03-10T03:00:00.000Z', startWindowMinutes: 360 });
      el.querySelector<HTMLElement>('.mode-exact button')!.click();
      await settle();
      form().patchValue({ date: new Date(2027, 2, 9), time: '23:30' });
      await submit();
      const req = http.expectOne('/api/sessions/41/reschedule');
      expect(req.request.body).toEqual({
        startsAt: '2027-03-10T04:30:00.000Z',
        startWindowMinutes: null,
      });
      req.flush({ ...session, startsAt: '2027-03-10T04:30:00.000Z' });
      await settle();
      expect(close).toHaveBeenCalled();
    });

    it('a past moment outside the window or keeping the window is rejected', async () => {
      await submit();
      http.expectNone('/api/sessions/41/reschedule');
      expect(el.textContent).toContain('sessions.reschedule.past');
      el.querySelector<HTMLElement>('.mode-exact button')!.click();
      form().patchValue({ time: '13:30' });
      await submit();
      http.expectNone('/api/sessions/41/reschedule');
    });
  });
});
