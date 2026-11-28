import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { ConfirmDialog, type ConfirmDialogData } from './confirm-dialog';

describe('ConfirmDialog', () => {
  async function create(data: ConfirmDialogData) {
    await TestBed.configureTestingModule({
      imports: [ConfirmDialog],
      providers: [
        provideTranslateService({ fallbackLang: 'uk' }),
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ConfirmDialog);
    fixture.detectChanges();
    const buttons = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
        'mat-dialog-actions button',
      ),
    ];
    return { cancel: buttons[0]!, confirm: buttons[1]! };
  }

  it('danger: «Cancel» outlined on the left, the confirm filled in the danger colour on the right', async () => {
    const { cancel, confirm } = await create({ title: 't', text: 'x', confirm: 'c', danger: true });
    expect(cancel.classList).toContain('mat-mdc-outlined-button');
    expect(confirm.classList).toContain('mat-mdc-unelevated-button');
    expect(confirm.classList).toContain('nri-danger-filled');
  });

  it('non-danger: the confirm is a regular filled button', async () => {
    const { confirm } = await create({ title: 't', text: 'x', confirm: 'c' });
    expect(confirm.classList).toContain('mat-mdc-unelevated-button');
    expect(confirm.classList).not.toContain('nri-danger-filled');
  });
});
