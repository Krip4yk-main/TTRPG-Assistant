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

  beforeEach(async () => {
    close = vi.fn();
    const data: RescheduleDialogData = {
      session,
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
});
