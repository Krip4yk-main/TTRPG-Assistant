import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { commonTimes, session } from '../scheduling-testing';
import { CommonTimesDialog, type CommonTimesDialogData } from './common-times-dialog';

describe('CommonTimesDialog', () => {
  let fixture: ComponentFixture<CommonTimesDialog>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let close: ReturnType<typeof vi.fn>;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function open(patch: Partial<CommonTimesDialogData> = {}) {
    close = vi.fn();
    const data: CommonTimesDialogData = {
      gameId: 7,
      kind: 'campaign',
      viewerTimezone: 'Europe/Warsaw',
      paused: false,
      ...patch,
    };
    await TestBed.configureTestingModule({
      imports: [CommonTimesDialog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CommonTimesDialog);
    el = fixture.nativeElement as HTMLElement;
    await settle();
  }

  const candidates = () => [...el.querySelectorAll<HTMLElement>('li.candidate')];
  const check = async (i: number) => {
    candidates()[i]!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    await settle();
  };
  const tab = async (value: 'regular' | 'oneOff') => {
    const toggles = [...el.querySelectorAll<HTMLButtonElement>('mat-button-toggle button')];
    toggles[value === 'regular' ? 0 : 1]!.click();
    await settle();
  };

  afterEach(() => http.verify());

  it('GM-only finder: regular candidates with per-participant status text, in the viewer zone', async () => {
    await open();
    http.expectOne('/api/games/7/common-times').flush(commonTimes());
    await settle();
    expect(candidates().length).toBe(2);
    const first = candidates()[0]!;
    // Пт 19:00 у Києві = 18:00 у Варшаві; без назви поясу.
    const c = commonTimes().regular[0]!;
    expect(fixture.componentInstance['weekly'](c)).toEqual({ weekday: 4, time: '18:00' });
    expect(fixture.componentInstance['firstLabel'](c)).toContain('18:00');
    expect(first.textContent).not.toMatch(/GMT|EET|CET/);
    expect(first.textContent).toContain('scheduling.counts');
    const statuses = [...first.querySelectorAll('nri-participant-statuses li')];
    expect(statuses.map((s) => s.getAttribute('data-status'))).toEqual(['can', 'can', 'unknown']);
    // Колір не єдиний носій: є текст статусу, значок прихований від читачів екрана.
    expect(statuses[2]!.textContent).toContain('scheduling.status.unknown');
    expect(statuses[2]!.textContent).toContain('scheduling.status.noCalendar');
    expect(statuses[1]!.textContent).toContain('scheduling.status.outside');
    expect(statuses[0]!.querySelector('mat-icon')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('noCalendars: an empty-state hint instead of lists and poll button', async () => {
    await open();
    http
      .expectOne('/api/games/7/common-times')
      .flush(commonTimes({ noCalendars: true, regular: [], oneOff: [] }));
    await settle();
    expect(el.querySelector('.no-calendars')!.textContent).toContain(
      'scheduling.finder.noCalendars',
    );
    expect(candidates().length).toBe(0);
    expect(el.querySelector('button.create-poll')).toBeNull();
  });

  it('picking 2 regular candidates creates a poll prefill; 1 is not enough', async () => {
    await open();
    http.expectOne('/api/games/7/common-times').flush(commonTimes());
    await settle();
    const create = () => el.querySelector<HTMLButtonElement>('button.create-poll')!;
    expect(create().disabled).toBe(true);
    await check(0);
    expect(create().disabled).toBe(true);
    await check(1);
    expect(create().disabled).toBe(false);
    create().click();
    expect(close).toHaveBeenCalledWith({
      kind: 'poll',
      pollKind: 'regular',
      options: [
        { weekday: 4, startMin: 1140, startsAt: '2030-03-01T17:00:00.000Z' },
        { weekday: 5, startMin: 1080, startsAt: '2030-03-02T16:00:00.000Z' },
      ],
    });
  });

  it('switching tabs clears the selection; one-off poll options are exact instants', async () => {
    await open();
    http.expectOne('/api/games/7/common-times').flush(commonTimes());
    await settle();
    await check(0);
    await tab('oneOff');
    expect(el.querySelector('.selected-count')!.textContent).toContain(
      'scheduling.finder.selected',
    );
    expect(fixture.componentInstance['selected']().size).toBe(0);
    await check(0);
    await check(1);
    el.querySelector<HTMLButtonElement>('button.create-poll')!.click();
    expect(close).toHaveBeenCalledWith({
      kind: 'poll',
      pollKind: 'one_off',
      options: [{ startsAt: '2030-03-08T17:00:00.000Z' }, { startsAt: '2030-03-09T16:00:00.000Z' }],
    });
  });

  it('«Застосувати як розклад» hands the candidate to the schedule dialog', async () => {
    await open();
    http.expectOne('/api/games/7/common-times').flush(commonTimes());
    await settle();
    candidates()[0]!.querySelector<HTMLButtonElement>('button.apply-schedule')!.click();
    expect(close).toHaveBeenCalledWith({
      kind: 'schedule',
      startsAt: '2030-03-01T17:00:00.000Z',
      weekday: 4,
    });
  });

  it('«Перенести сесію»: pick the session, then the existing reschedule API', async () => {
    await open();
    http.expectOne('/api/games/7/common-times').flush(commonTimes());
    await settle();
    await tab('oneOff');
    candidates()[0]!.querySelector<HTMLButtonElement>('button.start-move')!.click();
    await settle();
    http
      .expectOne('/api/games/7/sessions')
      .flush([
        session({ id: 40, startsAt: '2020-01-01T10:00:00.000Z', status: 'done' }),
        session({ id: 41 }),
        session({ id: 42, startsAt: '2030-03-14T17:00:00.000Z' }),
      ]);
    await settle();
    const select = el.querySelector<HTMLSelectElement>('select.move-select')!;
    expect([...select.options].map((o) => o.value)).toEqual(['41', '42']);
    select.value = '42';
    select.dispatchEvent(new Event('change'));
    el.querySelector<HTMLButtonElement>('button.confirm-move')!.click();
    const req = http.expectOne('/api/sessions/42/reschedule');
    expect(req.request.body).toEqual({ startsAt: '2030-03-08T17:00:00.000Z' });
    const moved = session({ id: 42, startsAt: '2030-03-08T17:00:00.000Z' });
    req.flush(moved);
    await settle();
    expect(close).toHaveBeenCalledWith({ kind: 'rescheduled', session: moved });
  });

  it('reschedule errors stay in the dialog', async () => {
    await open({ kind: 'oneshot' });
    http.expectOne('/api/games/7/common-times').flush(commonTimes({ regular: [] }));
    await settle();
    // Ваншот — лише разові варіанти, без вкладок.
    expect(el.querySelector('mat-button-toggle-group')).toBeNull();
    candidates()[0]!.querySelector<HTMLButtonElement>('button.start-move')!.click();
    await settle();
    http.expectOne('/api/games/7/sessions').flush([session()]);
    await settle();
    el.querySelector<HTMLButtonElement>('button.confirm-move')!.click();
    http
      .expectOne('/api/sessions/41/reschedule')
      .flush({ error: { code: 'GAME_IN_PAST' } }, { status: 422, statusText: 'x' });
    await settle();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('scheduling.finder.past');
    expect(close).not.toHaveBeenCalled();
  });

  it('paused campaign: candidates and polls, but no «apply» or «move»', async () => {
    await open({ paused: true });
    http.expectOne('/api/games/7/common-times').flush(commonTimes());
    await settle();
    expect(el.querySelector('button.apply-schedule')).toBeNull();
    await tab('oneOff');
    expect(el.querySelector('button.start-move')).toBeNull();
    expect(el.querySelector('button.create-poll')).not.toBeNull();
  });

  it('load error offers a retry', async () => {
    await open();
    http
      .expectOne('/api/games/7/common-times')
      .flush({ error: { code: 'INTERNAL' } }, { status: 500, statusText: 'x' });
    await settle();
    el.querySelector<HTMLButtonElement>('.load-error button')!.click();
    http.expectOne('/api/games/7/common-times').flush(commonTimes());
    await settle();
    expect(candidates().length).toBe(2);
  });
});
