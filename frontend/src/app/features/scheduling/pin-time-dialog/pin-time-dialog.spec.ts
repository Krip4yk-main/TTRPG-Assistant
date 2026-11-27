import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { session, windowSlots } from '../scheduling-testing';
import { PinTimeDialog, type PinTimeDialogData } from './pin-time-dialog';

describe('PinTimeDialog', () => {
  let fixture: ComponentFixture<PinTimeDialog>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let close: ReturnType<typeof vi.fn>;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create(
    data: PinTimeDialogData = { sessionId: 41, viewerTimezone: 'Europe/Kyiv' },
  ) {
    close = vi.fn();
    await TestBed.configureTestingModule({
      imports: [PinTimeDialog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PinTimeDialog);
    el = fixture.nativeElement as HTMLElement;
    await settle();
  }

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  const items = () => [...el.querySelectorAll<HTMLElement>('li.candidate')];

  it('lists every 30-min start of the window with who can, and pins in one click', async () => {
    await create();
    http.expectOne('/api/sessions/41/window-slots').flush(windowSlots());
    await settle();
    expect(el.querySelector('.current')!.textContent).toContain('sessions.pin.current');
    // 19:00, 19:30, 20:00 за Києвом.
    expect(items().map((li) => li.dataset['key'])).toEqual([
      '2030-03-07T17:00:00.000Z',
      '2030-03-07T17:30:00.000Z',
      '2030-03-07T18:00:00.000Z',
    ]);
    expect(items()[1]!.textContent).toContain('19:30');
    expect(items()[1]!.querySelectorAll('nri-participant-statuses li').length).toBe(3);
    expect(el.querySelector('.started')).toBeNull();
    items()[1]!.querySelector<HTMLButtonElement>('button.pin')!.click();
    const req = http.expectOne('/api/sessions/41/reschedule');
    expect(req.request.body).toEqual({
      startsAt: '2030-03-07T17:30:00.000Z',
      startWindowMinutes: null,
    });
    const pinned = session({ startsAt: '2030-03-07T17:30:00.000Z', rescheduled: true });
    req.flush(pinned);
    await settle();
    expect(close).toHaveBeenCalledWith(pinned);
  });

  it('a started window also offers its past starts (no availability for them)', async () => {
    // «Зараз» — 19:40 за Києвом: 19:00 і 19:30 уже минули, сервер оцінює лише 20:00.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-03-07T17:40:00.000Z'));
    const slots = windowSlots();
    await create({
      sessionId: 41,
      viewerTimezone: 'Europe/Kyiv',
      slots: { ...slots, slots: slots.slots.slice(2) },
    });
    // Варіанти вже передано — без повторного запиту.
    http.expectNone('/api/sessions/41/window-slots');
    expect(items().length).toBe(3);
    expect(items().map((li) => li.classList.contains('past'))).toEqual([true, true, false]);
    expect(items()[0]!.textContent).toContain('sessions.pin.pastOption');
    expect(items()[0]!.querySelector('nri-participant-statuses')).toBeNull();
    expect(el.querySelector('.started')!.textContent).toContain('sessions.pin.started');
    items()[0]!.querySelector<HTMLButtonElement>('button.pin')!.click();
    const req = http.expectOne('/api/sessions/41/reschedule');
    expect(req.request.body).toEqual({
      startsAt: '2030-03-07T17:00:00.000Z',
      startWindowMinutes: null,
    });
    req.flush(session({ startsAt: '2030-03-07T17:00:00.000Z' }));
    await settle();
    expect(close).toHaveBeenCalled();
  });

  it('an exact session explains there is nothing to pin; a done one — stale', async () => {
    await create();
    http
      .expectOne('/api/sessions/41/window-slots')
      .flush(windowSlots({ startWindowMinutes: null, slots: [] }));
    await settle();
    expect(el.querySelector('.exact')!.textContent).toContain('sessions.pin.exact');
    expect(items().length).toBe(0);

    fixture.componentInstance['load']();
    http
      .expectOne('/api/sessions/41/window-slots')
      .flush({ error: { code: 'SESSION_INVALID_STATE' } }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(el.querySelector('.stale')!.textContent).toContain('sessions.pin.stale');
  });

  it('a pin rejected as outside the window shows an error and keeps the list', async () => {
    await create();
    http.expectOne('/api/sessions/41/window-slots').flush(windowSlots());
    await settle();
    items()[0]!.querySelector<HTMLButtonElement>('button.pin')!.click();
    http
      .expectOne('/api/sessions/41/reschedule')
      .flush({ error: { code: 'GAME_IN_PAST' } }, { status: 422, statusText: 'Unprocessable' });
    await settle();
    expect(el.textContent).toContain('sessions.pin.past');
    expect(items().length).toBe(3);
    expect(close).not.toHaveBeenCalled();
  });
});
