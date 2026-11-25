import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { MODERATION_TEXT_MAX } from '@nri/shared';
import { ComplaintDialog, type ComplaintDialogData } from './complaint-dialog';

describe('ComplaintDialog', () => {
  let fixture: ComponentFixture<ComplaintDialog>;
  let http: HttpTestingController;
  let close: ReturnType<typeof vi.fn>;
  let el: HTMLElement;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create(data: ComplaintDialogData) {
    close = vi.fn();
    await TestBed.configureTestingModule({
      imports: [ComplaintDialog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ComplaintDialog);
    el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle();
  }

  afterEach(() => {
    http.verify();
    el.remove();
    document.querySelectorAll('.cdk-overlay-container').forEach((c) => (c.innerHTML = ''));
  });

  const pickReason = async (index: number) => {
    el.querySelector<HTMLElement>('mat-select.reason .mat-mdc-select-trigger')!.click();
    await settle();
    document.querySelectorAll<HTMLElement>('mat-option')[index]!.click();
    await settle();
  };
  const type = async (value: string) => {
    const area = el.querySelector<HTMLTextAreaElement>('textarea.message')!;
    area.value = value;
    area.dispatchEvent(new Event('input'));
    await settle();
  };
  const submit = async () => {
    el.querySelector<HTMLButtonElement>('button.send')!.click();
    await settle();
  };

  it('the reason is required: nothing is sent without it', async () => {
    await create({ kind: 'user', publicId: 'u-7', name: 'Ярема' });
    expect(el.querySelector('h2')!.textContent).toContain('moderation.complain.userTitle');
    await type('Не прийшов');
    await submit();
    http.expectNone('/api/complaints');
    expect(el.querySelector('.reason-error')!.textContent).toContain(
      'moderation.complain.reasonRequired',
    );
    expect(close).not.toHaveBeenCalled();
  });

  it('limits the text to 2000 characters', async () => {
    await create({ kind: 'user', publicId: 'u-7', name: 'Ярема' });
    const area = el.querySelector<HTMLTextAreaElement>('textarea.message')!;
    expect(area.getAttribute('maxlength')).toBe(String(MODERATION_TEXT_MAX));
    await pickReason(0);
    await type('x'.repeat(MODERATION_TEXT_MAX + 1));
    await submit();
    http.expectNone('/api/complaints');
    expect(el.textContent).toContain('moderation.tooLong');
  });

  it('sends a complaint about a person with the trimmed text and closes', async () => {
    await create({ kind: 'user', publicId: 'u-7', name: 'Ярема' });
    await pickReason(2);
    await type('  Не прийшов на сесію  ');
    await submit();
    const req = http.expectOne('/api/complaints');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      targetUserId: 'u-7',
      reason: 'no_show',
      message: 'Не прийшов на сесію',
    });
    req.flush({ id: 9 }, { status: 201, statusText: 'Created' });
    await settle();
    expect(close).toHaveBeenCalledWith(true);
  });

  it('sends a complaint about a game', async () => {
    await create({ kind: 'game', gameId: 12, name: 'Туман' });
    expect(el.querySelector('h2')!.textContent).toContain('moderation.complain.gameTitle');
    await pickReason(4);
    await submit();
    const req = http.expectOne('/api/complaints');
    expect(req.request.body).toEqual({
      targetGameId: 12,
      reason: 'inappropriate_content',
      message: '',
    });
    req.flush({ id: 10 }, { status: 201, statusText: 'Created' });
    await settle();
    expect(close).toHaveBeenCalledWith(true);
  });

  it('403 COMPLAINT_NOT_ALLOWED is shown in the dialog, which stays open', async () => {
    await create({ kind: 'user', publicId: 'u-7', name: 'Ярема' });
    await pickReason(0);
    await submit();
    http
      .expectOne('/api/complaints')
      .flush(
        { error: { code: 'COMPLAINT_NOT_ALLOWED' } },
        { status: 403, statusText: 'Forbidden' },
      );
    await settle();
    const alert = el.querySelector('.submit-error')!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('errors.COMPLAINT_NOT_ALLOWED');
    expect(close).not.toHaveBeenCalled();
    expect(el.querySelector<HTMLButtonElement>('button.send')!.disabled).toBe(false);
  });
});
