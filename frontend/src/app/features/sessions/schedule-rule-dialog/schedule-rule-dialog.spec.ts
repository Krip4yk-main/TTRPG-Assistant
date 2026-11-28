import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import type { GameDto } from '@nri/shared';
import { ScheduleRuleDialog, type ScheduleRuleDialogData } from './schedule-rule-dialog';
import { openOptions, optionText, selectedText } from '../../../../testing/mat-select';

const game = {
  id: 7,
  kind: 'campaign',
  status: 'started',
  timezone: 'Europe/Kyiv',
  startsAt: '2027-03-02T17:00:00.000Z',
  nextSessionAt: '2027-03-02T17:00:00.000Z',
  durationMinutes: 240,
  startWindowMinutes: null,
  recurrence: 'weekly',
  weekdays: [1],
} as GameDto;

describe('ScheduleRuleDialog', () => {
  let fixture: ComponentFixture<ScheduleRuleDialog>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let close: ReturnType<typeof vi.fn>;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create(data: ScheduleRuleDialogData) {
    close = vi.fn();
    await TestBed.configureTestingModule({
      imports: [ScheduleRuleDialog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ScheduleRuleDialog);
    el = fixture.nativeElement as HTMLElement;
    await settle();
  }

  afterEach(() => http.verify());

  const form = () => fixture.componentInstance['form'];
  const submit = async () => {
    el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settle();
  };

  it('prefills the current rule with the next session in the game zone', async () => {
    await create({ game, mode: 'schedule' });
    const v = form().getRawValue();
    expect([v.date!.getFullYear(), v.date!.getMonth() + 1, v.date!.getDate()]).toEqual([
      2027, 3, 2,
    ]);
    expect(v.time).toBe('19:00');
    expect(v.recurrence).toBe('weekly');
    expect(v.weekdays).toEqual([1]);
  });

  it('a candidate from the common-time finder prefills start and weekday', async () => {
    // Пт, 8 березня 2030, 19:00 у Києві.
    await create({
      game: { ...game, recurrence: 'none', weekdays: [] },
      mode: 'schedule',
      prefill: { startsAt: '2030-03-08T17:00:00.000Z', weekdays: [4] },
    });
    const v = form().getRawValue();
    expect([v.date!.getFullYear(), v.date!.getMonth() + 1, v.date!.getDate()]).toEqual([
      2030, 3, 8,
    ]);
    expect(v.time).toBe('19:00');
    // Гра без повторення стає щотижневою — варіант регулярний.
    expect(v.recurrence).toBe('weekly');
    expect(v.weekdays).toEqual([4]);
  });

  it('a past prefill is ignored (the usual next-session start is used)', async () => {
    await create({
      game,
      mode: 'schedule',
      prefill: { startsAt: '2020-03-06T17:00:00.000Z', weekdays: [4] },
    });
    expect(form().getRawValue().weekdays).toEqual([1]);
  });

  it('a started game with a past first session gets a future date prefilled', async () => {
    await create({
      game: { ...game, startsAt: '2020-01-07T17:00:00.000Z', nextSessionAt: null },
      mode: 'schedule',
    });
    const v = form().getRawValue();
    expect(v.date!.getTime()).toBeGreaterThan(Date.now() - 86_400_000);
    expect(v.time).toBe('19:00');
  });

  it('weekdays must include the day of the first session', async () => {
    await create({ game, mode: 'schedule' });
    form().patchValue({ date: new Date(2027, 2, 4) }); // четвер
    await submit();
    http.expectNone('/api/games/7/schedule');
    expect(el.textContent).toContain('sessions.rule.weekdaysError');

    form().patchValue({ weekdays: [1, 3] });
    await submit();
    const req = http.expectOne('/api/games/7/schedule');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({
      startsAt: '2027-03-04T17:00:00.000Z',
      durationMinutes: 240,
      startWindowMinutes: null,
      recurrence: 'weekly',
      weekdays: [1, 3],
    });
    req.flush({ ...game, weekdays: [1, 3] });
    await settle();
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ weekdays: [1, 3] }));
  });

  it('a past first session is rejected without a request', async () => {
    await create({ game, mode: 'schedule' });
    form().patchValue({ date: new Date(2020, 0, 7) });
    await submit();
    http.expectNone('/api/games/7/schedule');
    expect(el.textContent).toContain('sessions.rule.past');
  });

  it('convert: no «none» recurrence; POSTs convert-to-campaign', async () => {
    await create({
      game: { ...game, kind: 'oneshot', recurrence: 'none', weekdays: [] },
      mode: 'convert',
    });
    const options = (
      await openOptions(el.querySelector<HTMLElement>('mat-select.recurrence')!, settle)
    ).map(optionText);
    expect(options).toEqual([
      'games.recurrence.weekly',
      'games.recurrence.biweekly',
      'games.recurrence.monthly',
    ]);
    // Типово — щотижня в день першої сесії (вівторок).
    expect(form().getRawValue().weekdays).toEqual([1]);
    await submit();
    const req = http.expectOne('/api/games/7/convert-to-campaign');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      startsAt: '2027-03-02T17:00:00.000Z',
      durationMinutes: 240,
      startWindowMinutes: null,
      recurrence: 'weekly',
      weekdays: [1],
    });
    req.flush({ ...game, kind: 'campaign' });
    await settle();
    expect(close).toHaveBeenCalled();
  });

  it('approximate time: «from» on a 30-min grid and «to» send a start window', async () => {
    await create({ game, mode: 'schedule' });
    // 19:00 за Києвом; «Приблизно» — типове вікно 3 год.
    el.querySelector<HTMLElement>('.mode-approx button')!.click();
    await settle();
    expect(form().getRawValue().startWindowMinutes).toBe(180);
    const from = el.querySelector<HTMLElement>('mat-select.window-from')!;
    expect(selectedText(from)).toBe('19:00');
    const to = (
      await openOptions(el.querySelector<HTMLElement>('mat-select.window-to')!, settle)
    ).map(optionText);
    // 30 хв … 12 год; після півночі — «наступного дня».
    expect(to.length).toBe(24);
    expect(to[0]).toBe('sessions.window.end');
    expect(to.at(-1)).toBe('sessions.window.endNextDay');
    form().patchValue({ startWindowMinutes: 120 });
    await submit();
    const req = http.expectOne('/api/games/7/schedule');
    expect(req.request.body).toMatchObject({
      startsAt: '2027-03-02T17:00:00.000Z',
      startWindowMinutes: 120,
    });
    req.flush({ ...game, startWindowMinutes: 120 });
    await settle();
  });

  it('a windowed rule opens in «approximate» mode; «exact» clears the window', async () => {
    await create({ game: { ...game, startWindowMinutes: 90 }, mode: 'schedule' });
    expect(el.querySelector('mat-select.window-to')).not.toBeNull();
    el.querySelector<HTMLElement>('.mode-exact button')!.click();
    await settle();
    expect(el.querySelector('mat-select.window-to')).toBeNull();
    expect(el.querySelector('input.time')).not.toBeNull();
    await submit();
    const req = http.expectOne('/api/games/7/schedule');
    expect(req.request.body).toMatchObject({ startWindowMinutes: null });
    req.flush(game);
    await settle();
  });
});
