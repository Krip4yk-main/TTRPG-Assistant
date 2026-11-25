import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { CancelSessionDialog, type CancelSessionDialogData } from './cancel-session-dialog';

describe('CancelSessionDialog', () => {
  let fixture: ComponentFixture<CancelSessionDialog>;
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
    const data: CancelSessionDialogData = { sessionId: 41, when: '9 бер. 2027 р., 02:00' };
    await TestBed.configureTestingModule({
      imports: [CancelSessionDialog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CancelSessionDialog);
    el = fixture.nativeElement as HTMLElement;
    await settle();
  });

  afterEach(() => http.verify());

  const submit = async () => {
    el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settle();
  };

  it('a reason is required', async () => {
    await submit();
    http.expectNone('/api/sessions/41/cancel');
    const area = el.querySelector<HTMLTextAreaElement>('textarea')!;
    // Порожнє обов'язкове поле Material позначає aria-required, а помилку — mat-error поруч.
    expect(el.querySelector('mat-error')!.textContent).toContain('sessions.cancel.required');
    expect(document.activeElement).toBe(area);
  });

  it('POSTs the trimmed reason and closes with the session', async () => {
    const area = el.querySelector<HTMLTextAreaElement>('textarea')!;
    area.value = '  Майстер захворів ';
    area.dispatchEvent(new Event('input'));
    await settle();
    await submit();
    const req = http.expectOne('/api/sessions/41/cancel');
    expect(req.request.body).toEqual({ reason: 'Майстер захворів' });
    req.flush({ id: 41, status: 'cancelled' });
    await settle();
    expect(close).toHaveBeenCalledWith({ id: 41, status: 'cancelled' });
  });
});
