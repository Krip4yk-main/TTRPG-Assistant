import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import type { MemberDto } from '@nri/shared';
import { FinishSessionDialog, type FinishSessionDialogData } from './finish-session-dialog';

const member = (publicId: string, nickname: string | null): MemberDto => ({
  publicId,
  nickname,
  avatarUrl: null,
  joinedAt: '2026-11-10T10:00:00.000Z',
});

describe('FinishSessionDialog', () => {
  let fixture: ComponentFixture<FinishSessionDialog>;
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
    const data: FinishSessionDialogData = { sessionId: 41, gameId: 3, when: '1 лист.' };
    await TestBed.configureTestingModule({
      imports: [FinishSessionDialog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(FinishSessionDialog);
    el = fixture.nativeElement as HTMLElement;
    await settle();
    http
      .expectOne('/api/games/3/members')
      .flush([
        member('aaaaaaaaaa', 'Frodo'),
        member('bbbbbbbbbb', 'Sam'),
        member('cccccccccc', null),
      ]);
    await settle();
  });

  afterEach(() => http.verify());

  const box = (publicId: string) =>
    el.querySelector<HTMLInputElement>(`[data-member-id="${publicId}"] input[type="checkbox"]`)!;

  it('lists every member checked as present by default', () => {
    expect(box('aaaaaaaaaa').checked).toBe(true);
    expect(box('bbbbbbbbbb').checked).toBe(true);
    expect(el.querySelector('[data-member-id="cccccccccc"]')!.textContent).toContain(
      'user.deleted',
    );
  });

  it('sends attendance for all members (absent ones included) and the summary', async () => {
    box('bbbbbbbbbb').click();
    await settle();
    const area = el.querySelector<HTMLTextAreaElement>('textarea.summary')!;
    area.value = '  Знайшли карту  ';
    area.dispatchEvent(new Event('input'));
    await settle();
    el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settle();
    const req = http.expectOne('/api/sessions/41/finish');
    expect(req.request.body).toEqual({
      attendance: [
        { publicId: 'aaaaaaaaaa', present: true },
        { publicId: 'bbbbbbbbbb', present: false },
        { publicId: 'cccccccccc', present: true },
      ],
      summary: 'Знайшли карту',
    });
    req.flush({ id: 41, status: 'done' });
    await settle();
    expect(close).toHaveBeenCalledWith({ id: 41, status: 'done' });
  });

  it('an empty summary is sent as null', async () => {
    el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settle();
    const req = http.expectOne('/api/sessions/41/finish');
    expect(req.request.body.summary).toBeNull();
    expect(req.request.body.attendance).toHaveLength(3);
    req.flush({ id: 41, status: 'done' });
    await settle();
  });
});
