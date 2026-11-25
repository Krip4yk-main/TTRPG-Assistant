import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { OwnerTransferDialog, type OwnerTransferDialogData } from './owner-transfer-dialog';

describe('OwnerTransferDialog', () => {
  let fixture: ComponentFixture<OwnerTransferDialog>;
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
    const data: OwnerTransferDialogData = { publicId: 'admin00001', nickname: 'Gandalf' };
    await TestBed.configureTestingModule({
      imports: [OwnerTransferDialog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(OwnerTransferDialog);
    el = fixture.nativeElement as HTMLElement;
    await settle();
  });

  afterEach(() => http.verify());

  const type = async (value: string) => {
    const input = el.querySelector<HTMLInputElement>('input.nickname')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  };
  const confirm = () => el.querySelector<HTMLButtonElement>('button.confirm')!;

  it('warns and keeps the confirm button disabled until the nickname matches', async () => {
    expect(el.querySelector('.warning')!.textContent).toContain('admin.transfer.warning');
    expect(confirm().disabled).toBe(true);
    await type('Gandal');
    expect(confirm().disabled).toBe(true);
    confirm().click();
    await settle();
    http.expectNone('/api/admin/owner/transfer');
    await type('  gandalf ');
    expect(confirm().disabled).toBe(false);
  });

  it('confirmed transfer sends the target and the typed nickname; closes with the new owner', async () => {
    await type('Gandalf');
    confirm().click();
    await settle();
    const req = http.expectOne('/api/admin/owner/transfer');
    expect(req.request.body).toEqual({ toPublicId: 'admin00001', confirmNickname: 'Gandalf' });
    const card = { publicId: 'admin00001', role: 'owner' };
    req.flush(card);
    await settle();
    expect(close).toHaveBeenCalledWith(card);
  });

  it.each(['NOT_ADMIN', 'NICKNAME_MISMATCH'])(
    '400 OWNER_TRANSFER_INVALID (%s) is explained in the dialog',
    async (reason) => {
      await type('Gandalf');
      confirm().click();
      await settle();
      http
        .expectOne('/api/admin/owner/transfer')
        .flush(
          { error: { code: 'OWNER_TRANSFER_INVALID', details: { reason } } },
          { status: 400, statusText: 'Bad Request' },
        );
      await settle();
      expect(el.querySelector('.submit-error')!.textContent).toContain(
        `admin.transfer.errors.${reason}`,
      );
      expect(close).not.toHaveBeenCalled();
    },
  );
});
