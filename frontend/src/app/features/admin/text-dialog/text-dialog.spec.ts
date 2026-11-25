import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { type Observable, of, throwError } from 'rxjs';
import type { Mock } from 'vitest';
import { DialogConflict } from '../dialog-conflict';
import { TextDialog, type TextDialogData } from './text-dialog';

describe('TextDialog', () => {
  let fixture: ComponentFixture<TextDialog>;
  let el: HTMLElement;
  let close: ReturnType<typeof vi.fn>;
  let submit: Mock<(text: string | undefined) => Observable<unknown>>;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create(required: boolean) {
    close = vi.fn();
    submit = vi.fn((): Observable<unknown> => of({ ok: true }));
    const data: TextDialogData = {
      title: 't',
      label: 'l',
      required,
      confirm: 'c',
      submit,
    };
    await TestBed.configureTestingModule({
      imports: [TextDialog],
      providers: [
        provideTranslateService(),
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(TextDialog);
    el = fixture.nativeElement as HTMLElement;
    await settle();
  }

  const confirm = async () => {
    el.querySelector<HTMLButtonElement>('button.confirm')!.click();
    await settle();
  };

  it('an optional note may be empty', async () => {
    await create(false);
    await confirm();
    expect(submit).toHaveBeenCalledWith(undefined);
    expect(close).toHaveBeenCalledWith({ ok: true });
  });

  it('a required reason blocks the request until given', async () => {
    await create(true);
    await confirm();
    expect(submit).not.toHaveBeenCalled();
    expect(el.textContent).toContain('admin.reasonRequired');
  });

  it('409 (already handled by someone else) closes with a conflict so the page reloads', async () => {
    await create(false);
    submit.mockReturnValue(
      throwError(
        () => new HttpErrorResponse({ status: 409, error: { error: { code: 'APPEAL_DECIDED' } } }),
      ),
    );
    await confirm();
    const result = close.mock.calls[0]![0] as DialogConflict;
    expect(result).toBeInstanceOf(DialogConflict);
    expect(result.code).toBe('APPEAL_DECIDED');
  });

  it('other errors stay in the dialog', async () => {
    await create(false);
    submit.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 403,
            error: { error: { code: 'MODERATION_FORBIDDEN' } },
          }),
      ),
    );
    await confirm();
    expect(close).not.toHaveBeenCalled();
    expect(el.querySelector('.submit-error')!.textContent).toContain('errors.MODERATION_FORBIDDEN');
  });
});
