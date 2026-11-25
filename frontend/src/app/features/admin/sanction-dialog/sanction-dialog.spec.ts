import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import type { SanctionInput, UserRole } from '@nri/shared';
import { type Observable, of, throwError } from 'rxjs';
import type { Mock } from 'vitest';
import { HttpErrorResponse } from '@angular/common/http';
import { SanctionDialog, type SanctionDialogData } from './sanction-dialog';

describe('SanctionDialog', () => {
  let fixture: ComponentFixture<SanctionDialog>;
  let el: HTMLElement;
  let close: ReturnType<typeof vi.fn>;
  let submit: Mock<(input: SanctionInput) => Observable<unknown>>;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create(actorRole: UserRole, extra: Partial<SanctionDialogData> = {}) {
    close = vi.fn();
    submit = vi.fn((input: SanctionInput): Observable<unknown> => of({ id: 1, ...input }));
    const data: SanctionDialogData = { name: 'Ярема', actorRole, submit, ...extra };
    await TestBed.configureTestingModule({
      imports: [SanctionDialog],
      providers: [
        provideTranslateService(),
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(SanctionDialog);
    el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle();
  }

  afterEach(() => {
    el.remove();
    document.querySelectorAll('.cdk-overlay-container').forEach((c) => (c.innerHTML = ''));
  });

  /** Опції саме цього списку (панель попереднього може ще бути в DOM під час закриття). */
  const openSelect = async (cls: string) => {
    const select = el.querySelector<HTMLElement>(`mat-select.${cls}`)!;
    select.querySelector<HTMLElement>('.mat-mdc-select-trigger')!.click();
    await settle();
    const panel = document.getElementById(select.getAttribute('aria-controls')!)!;
    return [...panel.querySelectorAll<HTMLElement>('mat-option')];
  };
  const typeReason = async (value: string) => {
    const area = el.querySelector<HTMLTextAreaElement>('textarea.reason')!;
    area.value = value;
    area.dispatchEvent(new Event('input'));
    await settle();
  };

  it('a moderator cannot pick a global ban', async () => {
    await create('moderator');
    const options = await openSelect('type');
    const labels = options.map((o) => o.textContent!.trim());
    expect(labels).toHaveLength(4);
    expect(labels).not.toContain('moderation.sanctionTypes.global_ban');
  });

  it.each(['admin', 'owner'] as const)('%s can pick a global ban', async (role) => {
    await create(role);
    const labels = (await openSelect('type')).map((o) => o.textContent!.trim());
    expect(labels).toContain('moderation.sanctionTypes.global_ban');
  });

  it('type and reason are required', async () => {
    await create('moderator');
    el.querySelector<HTMLButtonElement>('button.send')!.click();
    await settle();
    expect(submit).not.toHaveBeenCalled();
    expect(el.textContent).toContain('admin.sanction.typeRequired');
    expect(el.textContent).toContain('admin.reasonRequired');
  });

  it('sends type, duration and the trimmed reason; closes with the result', async () => {
    await create('admin');
    (await openSelect('type'))[1]!.click();
    await settle();
    (await openSelect('duration'))[1]!.click();
    await settle();
    await typeReason('  Спам заявками  ');
    el.querySelector<HTMLButtonElement>('button.send')!.click();
    await settle();
    expect(submit).toHaveBeenCalledWith({
      type: 'application_limit',
      duration: '30d',
      reason: 'Спам заявками',
    });
    expect(close).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, type: 'application_limit' }),
    );
  });

  it('a restricted type list (deleted account) preselects the only type', async () => {
    await create('admin', { types: ['global_ban'] });
    await typeReason('Ухилення');
    el.querySelector<HTMLButtonElement>('button.send')!.click();
    await settle();
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ type: 'global_ban' }));
  });

  it('server errors stay in the dialog', async () => {
    await create('moderator', { types: ['warning'] });
    submit.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 403,
            error: { error: { code: 'MODERATION_FORBIDDEN' } },
          }),
      ),
    );
    await typeReason('Причина');
    el.querySelector<HTMLButtonElement>('button.send')!.click();
    await settle();
    expect(el.querySelector('.submit-error')!.textContent).toContain('errors.MODERATION_FORBIDDEN');
    expect(close).not.toHaveBeenCalled();
  });
});
