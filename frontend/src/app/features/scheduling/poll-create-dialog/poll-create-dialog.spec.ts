import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { poll, session } from '../scheduling-testing';
import { PollCreateDialog, type PollCreateDialogData } from './poll-create-dialog';

describe('PollCreateDialog', () => {
  let fixture: ComponentFixture<PollCreateDialog>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let close: ReturnType<typeof vi.fn>;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function open(patch: Partial<PollCreateDialogData> = {}, sessions = [session()]) {
    close = vi.fn();
    const data: PollCreateDialogData = {
      gameId: 7,
      kind: 'campaign',
      timezone: 'Europe/Kyiv',
      viewerTimezone: 'Europe/Kyiv',
      ...patch,
    };
    await TestBed.configureTestingModule({
      imports: [PollCreateDialog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PollCreateDialog);
    el = fixture.nativeElement as HTMLElement;
    await settle();
    http.match('/api/games/7/sessions').forEach((r) => r.flush(sessions));
    await settle();
  }

  const submit = async () => {
    el.querySelector<HTMLButtonElement>('button.submit')!.click();
    await settle();
  };
  const setInput = (selector: string, value: string, event = 'input') => {
    const input = el.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event(event));
  };

  afterEach(() => http.verify());

  it('prefilled one-off options → POST with deadline and the chosen session', async () => {
    await open({
      prefill: {
        pollKind: 'one_off',
        options: [
          { startsAt: '2030-03-08T17:00:00.000Z' },
          { startsAt: '2030-03-09T16:00:00.000Z' },
        ],
      },
    });
    // Вид зафіксовано варіантами з підбору.
    expect(el.querySelector('mat-button-toggle-group')).toBeNull();
    expect(el.querySelectorAll('li.option').length).toBe(2);
    setInput('select.target', '41', 'change');
    const before = Date.now();
    await submit();
    const req = http.expectOne('/api/games/7/polls');
    expect(req.request.method).toBe('POST');
    const body = req.request.body;
    expect(body.kind).toBe('one_off');
    expect(body.sessionId).toBe(41);
    expect(body.options).toEqual([
      { startsAt: '2030-03-08T17:00:00.000Z' },
      { startsAt: '2030-03-09T16:00:00.000Z' },
    ]);
    // За замовчуванням — 2 доби.
    const hours = (Date.parse(body.closesAt) - before) / 3_600_000;
    expect(Math.round(hours)).toBe(48);
    const created = poll({ kind: 'one_off', sessionId: 41 });
    req.flush(created);
    await settle();
    expect(close).toHaveBeenCalledWith(created);
  });

  it('manual regular options in the game zone; duplicate refused; needs 2', async () => {
    await open({}, []);
    setInput('select.add-weekday', '4', 'change');
    setInput('input.add-time', '19:30');
    el.querySelector<HTMLButtonElement>('button.add-option')!.click();
    await settle();
    el.querySelector<HTMLButtonElement>('button.add-option')!.click();
    await settle();
    expect(el.textContent).toContain('scheduling.create.duplicate');
    await submit();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('scheduling.create.count');
    setInput('select.add-weekday', '6', 'change');
    el.querySelector<HTMLButtonElement>('button.add-option')!.click();
    await settle();
    setInput('select.deadline', '336', 'change');
    await submit();
    const req = http.expectOne('/api/games/7/polls');
    expect(req.request.body.kind).toBe('regular');
    expect(req.request.body.options).toEqual([
      { weekday: 4, startMin: 1170 },
      { weekday: 6, startMin: 1170 },
    ]);
    expect(req.request.body.sessionId).toBeUndefined();
    req.flush({ error: { code: 'POLL_LIMIT' } }, { status: 409, statusText: 'x' });
    await settle();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('errors.POLL_LIMIT');
    expect(close).not.toHaveBeenCalled();
  });

  it('one-off options must start after the deadline (checked before the request)', async () => {
    await open({ kind: 'oneshot' });
    const soon = new Date(Date.now() + 30 * 3_600_000).toISOString().slice(0, 10);
    setInput('input.add-date', soon);
    setInput('input.add-time', '23:00');
    el.querySelector<HTMLButtonElement>('button.add-option')!.click();
    setInput('input.add-date', '2030-03-08');
    el.querySelector<HTMLButtonElement>('button.add-option')!.click();
    await settle();
    expect(el.querySelectorAll('li.option').length).toBe(2);
    setInput('select.deadline', '336', 'change');
    await submit();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain(
      'scheduling.create.afterDeadline',
    );
    http.expectNone('/api/games/7/polls');
  });

  it('a past one-off is refused at the field', async () => {
    await open({ kind: 'oneshot' });
    setInput('input.add-date', '2020-01-01');
    el.querySelector<HTMLButtonElement>('button.add-option')!.click();
    await settle();
    expect(el.textContent).toContain('scheduling.finder.past');
    expect(el.querySelectorAll('li.option').length).toBe(0);
  });

  it('shows the viewer-zone preview when the zones differ', async () => {
    await open({ kind: 'oneshot', viewerTimezone: 'Europe/Warsaw' });
    setInput('input.add-date', '2030-03-08');
    setInput('input.add-time', '19:00');
    await settle();
    // 19:00 у Києві = 18:00 у Варшаві.
    expect(el.querySelector('.preview')).not.toBeNull();
    expect(fixture.componentInstance['addPreview']()).toContain('18:00');
  });
});
