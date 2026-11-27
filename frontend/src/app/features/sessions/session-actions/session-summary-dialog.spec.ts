import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { SessionSummaryDialog, type SessionSummaryDialogData } from './session-summary-dialog';

describe('SessionSummaryDialog', () => {
  let fixture: ComponentFixture<SessionSummaryDialog>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let close: ReturnType<typeof vi.fn>;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create(data: Partial<SessionSummaryDialogData> = {}) {
    close = vi.fn();
    await TestBed.configureTestingModule({
      imports: [SessionSummaryDialog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        {
          provide: MAT_DIALOG_DATA,
          useValue: { sessionId: 41, when: '1 лист.', summary: 'Було', sent: false, ...data },
        },
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(SessionSummaryDialog);
    el = fixture.nativeElement as HTMLElement;
    await settle();
  }

  afterEach(() => http.verify());

  const area = () => el.querySelector<HTMLTextAreaElement>('textarea')!;
  const submit = async () => {
    el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settle();
  };

  it('prefills the summary and PUTs the trimmed text', async () => {
    await create();
    expect(area().value).toBe('Було');
    expect(el.querySelector('.sent-hint')).toBeNull();
    area().value = '  Стало  ';
    area().dispatchEvent(new Event('input'));
    await settle();
    await submit();
    const req = http.expectOne('/api/sessions/41/summary');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ summary: 'Стало' });
    req.flush({ id: 41, summary: 'Стало' });
    await settle();
    expect(close).toHaveBeenCalledWith({ id: 41, summary: 'Стало' });
  });

  it('an emptied summary is sent as null; errors are shown', async () => {
    await create();
    area().value = ' ';
    area().dispatchEvent(new Event('input'));
    await settle();
    await submit();
    const req = http.expectOne('/api/sessions/41/summary');
    expect(req.request.body).toEqual({ summary: null });
    req.flush(
      { error: { code: 'SESSION_INVALID_STATE', message: 'x' } },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain(
      'errors.SESSION_INVALID_STATE',
    );
    expect(close).not.toHaveBeenCalled();
  });

  it('after sending, warns that edits are not sent again', async () => {
    await create({ sent: true, summary: null });
    expect(area().value).toBe('');
    expect(el.querySelector('.sent-hint')!.textContent).toContain(
      'sessions.summaryDialog.sentHint',
    );
  });
});
