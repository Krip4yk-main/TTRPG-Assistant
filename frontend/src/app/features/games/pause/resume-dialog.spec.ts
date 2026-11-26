import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { weekdayOf } from '@nri/shared';
import { ResumeDialog, type ResumeDialogData } from './resume-dialog';

const game: ResumeDialogData['game'] = {
  id: 7,
  title: 'Туман',
  timezone: 'Europe/Kyiv',
  startsAt: '2026-01-06T17:00:00.000Z', // вівторок, 19:00 за Києвом
  recurrence: 'weekly',
  weekdays: [1],
  minPlayers: 2,
  maxPlayers: 5,
  freeSlots: 2,
};

describe('ResumeDialog', () => {
  let fixture: ComponentFixture<ResumeDialog>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let close: ReturnType<typeof vi.fn>;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create(data: Partial<ResumeDialogData> = {}) {
    close = vi.fn();
    await TestBed.configureTestingModule({
      imports: [ResumeDialog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        {
          provide: MAT_DIALOG_DATA,
          useValue: {
            game,
            recruit: false,
            firstStart: false,
            viewerTimezone: 'Europe/Kyiv',
            ...data,
          },
        },
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ResumeDialog);
    el = fixture.nativeElement as HTMLElement;
    await settle();
  }

  afterEach(() => http.verify());

  const form = () => fixture.componentInstance['form'];
  const submit = async () => {
    el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settle();
  };
  const weekday = (d: Date) => weekdayOf(d.getFullYear(), d.getMonth() + 1, d.getDate());

  it('prefills the next rule day after today at the rule time; lists the rule days', async () => {
    await create();
    const v = form().getRawValue();
    expect(v.date!.getTime()).toBeGreaterThan(Date.now());
    expect(weekday(v.date!)).toBe(1);
    expect(v.time).toBe('19:00');
    expect(el.querySelector('.rule-days')!.textContent).toContain('games.weekdaysLong.1');
    // Дні правила озвучуються разом із полем дати.
    expect(el.querySelector('input.date')!.getAttribute('aria-describedby')).toContain(
      'resume-rule-days',
    );
    expect(el.querySelector('h2')!.textContent).toContain('games.pause.resume.title');
    // Учасників 3 із мінімуму 2 — попередження немає.
    expect(el.querySelector('.below-min')).toBeNull();
  });

  it('resume: POSTs startsAt in the game zone with recruit=false and closes with the DTO', async () => {
    await create();
    form().patchValue({ date: new Date(2030, 0, 1), time: '18:30' }); // вівторок
    await submit();
    const req = http.expectOne('/api/games/7/resume');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ startsAt: '2030-01-01T16:30:00.000Z', recruit: false });
    req.flush({ id: 7, status: 'started' });
    await settle();
    expect(close).toHaveBeenCalledWith({ id: 7, status: 'started' });
  });

  it('recruit: own title and recruit=true', async () => {
    await create({ recruit: true });
    expect(el.querySelector('h2')!.textContent).toContain('games.pause.recruit.title');
    expect(el.querySelector('button[type="submit"]')!.textContent).toContain(
      'games.pause.recruit.submit',
    );
    form().patchValue({ date: new Date(2030, 0, 1) });
    await submit();
    const req = http.expectOne('/api/games/7/resume');
    expect(req.request.body).toEqual({ startsAt: '2030-01-01T17:00:00.000Z', recruit: true });
    req.flush({ id: 7, status: 'started', showWhenFull: true });
    await settle();
  });

  it('a past date is rejected without a request', async () => {
    await create();
    form().patchValue({ date: new Date(2020, 0, 7) });
    await submit();
    http.expectNone('/api/games/7/resume');
    expect(el.querySelector('mat-error')!.textContent).toContain('sessions.rule.past');
    expect(document.activeElement).toBe(el.querySelector('input.date'));
  });

  it('a day outside the rule is rejected without a request', async () => {
    await create();
    form().patchValue({ date: new Date(2030, 0, 3) }); // четвер
    await submit();
    http.expectNone('/api/games/7/resume');
    expect(el.querySelector('mat-error')!.textContent).toContain('games.pause.weekdayError');
  });

  it('monthly rule: any future day is allowed', async () => {
    await create({ game: { ...game, recurrence: 'monthly', weekdays: [] } });
    expect(el.querySelector('.rule-days')).toBeNull();
    form().patchValue({ date: new Date(2030, 0, 3) });
    await submit();
    http.expectOne('/api/games/7/resume').flush({ id: 7, status: 'started' });
    await settle();
    expect(close).toHaveBeenCalled();
  });

  it('server GAME_IN_PAST and a weekdays VALIDATION issue land next to the date field', async () => {
    await create();
    form().patchValue({ date: new Date(2030, 0, 1) });
    await submit();
    http
      .expectOne('/api/games/7/resume')
      .flush({ error: { code: 'GAME_IN_PAST' } }, { status: 422, statusText: 'Unprocessable' });
    await settle();
    expect(el.querySelector('mat-error')!.textContent).toContain('sessions.rule.past');
    expect(close).not.toHaveBeenCalled();

    form().patchValue({ date: new Date(2030, 0, 8) });
    await submit();
    http
      .expectOne('/api/games/7/resume')
      .flush(
        { error: { code: 'VALIDATION', details: [{ path: ['weekdays'], message: 'x' }] } },
        { status: 400, statusText: 'Bad Request' },
      );
    await settle();
    expect(el.querySelector('mat-error')!.textContent).toContain('games.pause.weekdayError');

    form().patchValue({ date: new Date(2030, 0, 15) });
    await submit();
    http
      .expectOne('/api/games/7/resume')
      .flush({ error: { code: 'GAME_PAUSED' } }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('errors.GAME_PAUSED');
  });

  it('below the minimum on a campaign that already ran: no warning (the backend does not warn)', async () => {
    await create({ game: { ...game, minPlayers: 4, freeSlots: 3 }, firstStart: false });
    expect(el.querySelector('.below-min')).toBeNull();
  });

  it('first start below the minimum warns; viewer-zone preview has no zone label', async () => {
    await create({
      game: { ...game, minPlayers: 4, freeSlots: 3 },
      firstStart: true,
      viewerTimezone: 'America/New_York',
    });
    expect(el.querySelector('.below-min')!.textContent).toContain('games.pause.belowMin');
    form().patchValue({ date: new Date(2030, 0, 1), time: '19:00' });
    await settle();
    expect(el.querySelector('.preview')!.textContent).toContain('sessions.viewerPreview');
    const preview = fixture.componentInstance['preview']()!;
    expect(preview).toContain('12:00');
    expect(preview).not.toMatch(/GMT|EST|UTC/);
  });
});
