import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import uk from '../../../../assets/i18n/uk.json';
import { PauseDialog, type PauseDialogData } from './pause-dialog';

describe('PauseDialog', () => {
  let fixture: ComponentFixture<PauseDialog>;
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
    const data: PauseDialogData = { gameId: 7, title: 'Туман' };
    await TestBed.configureTestingModule({
      imports: [PauseDialog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PauseDialog);
    el = fixture.nativeElement as HTMLElement;
    await settle();
  });

  afterEach(() => http.verify());

  const submit = async () => {
    el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settle();
  };
  const radio = (value: string) =>
    [...el.querySelectorAll<HTMLInputElement>('mat-radio-button input')].find(
      (i) => i.value === value,
    )!;
  const type = async (text: string) => {
    const area = el.querySelector<HTMLTextAreaElement>('textarea')!;
    area.value = text;
    area.dispatchEvent(new Event('input'));
    await settle();
  };

  it('offers the four reasons with texts; the reason is required', async () => {
    const labels = [...el.querySelectorAll('mat-radio-button')].map((r) => r.textContent!.trim());
    expect(labels).toEqual([
      'games.pause.reasons.vacation',
      'games.pause.reasons.illness',
      'games.pause.reasons.study_work',
      'games.pause.reasons.other',
    ]);
    expect(uk.games.pause.reasons).toEqual({
      vacation: 'Відпустка',
      illness: 'Хвороба',
      study_work: 'Навчання чи робота',
      other: 'Інше',
    });
    await submit();
    http.expectNone('/api/games/7/pause');
    expect(el.querySelector('#pause-reason-error')!.textContent).toContain(
      'games.pause.dialog.reasonRequired',
    );
    expect(close).not.toHaveBeenCalled();
  });

  it('POSTs the reason and the trimmed note; the counter follows the note', async () => {
    radio('illness').click();
    await type('  Застуда, до тижня ');
    expect(el.querySelector('.counter')!.textContent).toContain('games.pause.dialog.counter');
    expect(el.querySelector('textarea')!.getAttribute('maxlength')).toBe('300');
    await submit();
    const req = http.expectOne('/api/games/7/pause');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ reason: 'illness', note: 'Застуда, до тижня' });
    req.flush({ id: 7, status: 'paused' });
    await settle();
    expect(close).toHaveBeenCalledWith({ id: 7, status: 'paused' });
  });

  it('an empty note is sent as null; an API error stays in the dialog', async () => {
    radio('vacation').click();
    await type('   ');
    await submit();
    const req = http.expectOne('/api/games/7/pause');
    expect(req.request.body).toEqual({ reason: 'vacation', note: null });
    req.flush(
      { error: { code: 'GAME_INVALID_TRANSITION' } },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain(
      'errors.GAME_INVALID_TRANSITION',
    );
    expect(close).not.toHaveBeenCalled();
  });
});
