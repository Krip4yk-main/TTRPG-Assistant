import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { LeaveDialog, type LeaveDialogData } from './leave-dialog';

describe('LeaveDialog', () => {
  let fixture: ComponentFixture<LeaveDialog>;
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
    const data: LeaveDialogData = { gameId: 3, title: 'Туман' };
    await TestBed.configureTestingModule({
      imports: [LeaveDialog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(LeaveDialog);
    el = fixture.nativeElement as HTMLElement;
    await settle();
  });

  afterEach(() => http.verify());

  const type = async (selector: string, text: string) => {
    const area = el.querySelector<HTMLTextAreaElement>(selector)!;
    area.value = text;
    area.dispatchEvent(new Event('input'));
    await settle();
  };
  const submit = async () => {
    el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settle();
  };

  it('explains that an empty note for the administration copies the note for the GM', () => {
    expect(el.textContent).toContain('members.leave.adminHint');
  });

  it('a note for the GM shorter than 10 characters blocks leaving', async () => {
    await type('textarea.note-gm', '  коротко  ');
    await submit();
    http.expectNone('/api/games/3/leave');
    const area = el.querySelector<HTMLTextAreaElement>('textarea.note-gm')!;
    expect(area.getAttribute('aria-invalid')).toBe('true');
    expect(el.textContent).toContain('members.leave.gmTooShort');
    expect(document.activeElement).toBe(area);
    expect(close).not.toHaveBeenCalled();
  });

  it('a long enough note POSTs leave and closes with true', async () => {
    await type('textarea.note-gm', '  Переїжджаю, не встигаю  ');
    await submit();
    const req = http.expectOne('/api/games/3/leave');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ noteForGm: 'Переїжджаю, не встигаю', noteForAdmin: null });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    expect(close).toHaveBeenCalledWith(true);
  });

  it('a server error stays in the dialog', async () => {
    await type('textarea.note-gm', 'Переїжджаю, не встигаю');
    await type('textarea.note-admin', 'Для адмінів');
    await submit();
    const req = http.expectOne('/api/games/3/leave');
    expect(req.request.body.noteForAdmin).toBe('Для адмінів');
    req.flush(
      { error: { code: 'GAME_INVALID_TRANSITION' } },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();
    expect(el.textContent).toContain('errors.GAME_INVALID_TRANSITION');
    expect(close).not.toHaveBeenCalled();
  });
});
