import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import type { ApplicationDto } from '@nri/shared';
import { ApplyDialog, type ApplyDialogData } from './apply-dialog';

const data: ApplyDialogData = {
  gameId: 7,
  title: 'Туман над Дніпром',
  warningSlugs: ['violence'],
  customWarnings: ['Павуки'],
  questions: ['Який у вас досвід?'],
};

const created: ApplicationDto = {
  id: 55,
  gameId: 7,
  status: 'pending',
  message: null,
  answers: ['Багато'],
  constraints: [],
  cancelReason: null,
  createdAt: '2026-11-25T10:00:00.000Z',
  decidedAt: null,
};

describe('ApplyDialog', () => {
  let fixture: ComponentFixture<ApplyDialog>;
  let http: HttpTestingController;
  let close: ReturnType<typeof vi.fn>;
  let el: HTMLElement;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create(d: ApplyDialogData = data) {
    close = vi.fn();
    await TestBed.configureTestingModule({
      imports: [ApplyDialog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        provideRouter([{ path: '**', children: [] }]),
        { provide: MAT_DIALOG_DATA, useValue: d },
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ApplyDialog);
    el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle();
  }

  afterEach(() => {
    http.verify();
    el.remove();
  });

  const type = async (selector: string, value: string) => {
    const input = el.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  };
  const accept = async () => {
    el.querySelector<HTMLInputElement>('.accept input[type="checkbox"]')!.click();
    await settle();
  };
  const submit = async () => {
    el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settle();
  };

  it('shows warnings as chips and the questions', async () => {
    await create();
    expect(el.querySelectorAll('nri-warning-chip')).toHaveLength(2);
    expect(el.textContent).toContain('Який у вас досвід?');
  });

  it('cannot submit without accepting the warnings: no request, error next to the checkbox', async () => {
    await create();
    await type('textarea.answer', 'Багато');
    await submit();
    http.expectNone('/api/games/7/applications');
    const err = el.querySelector('.accept-error')!;
    expect(err.textContent).toContain('games.applications.apply.acceptRequired');
    expect(document.activeElement).toBe(el.querySelector('.accept input[type="checkbox"]'));
    expect(close).not.toHaveBeenCalled();
  });

  it('answers are required', async () => {
    await create();
    await accept();
    await submit();
    http.expectNone('/api/games/7/applications');
    expect(el.textContent).toContain('games.applications.apply.answerRequired');
  });

  it('submits once (double click guarded) and closes with the application', async () => {
    await create();
    await accept();
    await type('textarea.answer', 'Багато');
    await type('textarea.message', 'Привіт!');
    el.querySelector<HTMLButtonElement>('button.add-constraint')!.click();
    await settle();
    await type('input.constraint', 'Без павуків');
    await submit();
    await submit();
    const req = http.expectOne('/api/games/7/applications');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      warningsAccepted: true,
      answers: ['Багато'],
      message: 'Привіт!',
      constraints: ['Без павуків'],
    });
    req.flush(created, { status: 201, statusText: 'Created' });
    await settle();
    expect(close).toHaveBeenCalledWith({ status: 'applied', application: created });
  });

  it('a game without warnings needs no consent', async () => {
    await create({ ...data, warningSlugs: [], customWarnings: [], questions: [] });
    expect(el.querySelector('.accept')).toBeNull();
    await submit();
    const req = http.expectOne('/api/games/7/applications');
    expect(req.request.body).toEqual({
      warningsAccepted: false,
      answers: [],
      message: null,
      constraints: [],
    });
    req.flush(created);
    await settle();
  });

  it('409 APPLICATION_EXISTS closes with the "already applied" state', async () => {
    await create();
    await accept();
    await type('textarea.answer', 'Багато');
    await submit();
    http
      .expectOne('/api/games/7/applications')
      .flush({ error: { code: 'APPLICATION_EXISTS' } }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(close).toHaveBeenCalledWith({ status: 'exists' });
  });

  it('other API errors are shown in the dialog and the form stays open', async () => {
    await create();
    await accept();
    await type('textarea.answer', 'Багато');
    await submit();
    http
      .expectOne('/api/games/7/applications')
      .flush({ error: { code: 'GM_BLACKLISTED' } }, { status: 403, statusText: 'Forbidden' });
    await settle();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('errors.GM_BLACKLISTED');
    expect(close).not.toHaveBeenCalled();
    expect(el.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  });

  it('409 SANCTION_ACTIVE explains the restriction with its end date and links to the details', async () => {
    await create();
    await accept();
    await type('textarea.answer', 'Багато');
    await submit();
    http.expectOne('/api/games/7/applications').flush(
      {
        error: {
          code: 'SANCTION_ACTIVE',
          details: { type: 'no_paid_apply', endsAt: '2026-12-02T10:00:00.000Z' },
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();
    const notice = el.querySelector('.sanction-active')!;
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toContain('moderation.sanctionActive.no_paid_apply');
    expect(notice.textContent).toContain('moderation.sanctionActive.until');
    expect(notice.textContent).not.toContain('errors.SANCTION_ACTIVE');
    const link = notice.querySelector<HTMLAnchorElement>('a')!;
    expect(link.getAttribute('href')).toBe('/my-sanctions');
    expect(close).not.toHaveBeenCalled();
    // Перехід до подробиць закриває діалог (інакше сторінка відкрилася б під ним).
    link.click();
    await settle();
    expect(close).toHaveBeenCalledWith();
  });

  it('409 SANCTION_ACTIVE without an end date says the restriction is permanent', async () => {
    await create();
    await accept();
    await type('textarea.answer', 'Багато');
    await submit();
    http.expectOne('/api/games/7/applications').flush(
      {
        error: { code: 'SANCTION_ACTIVE', details: { type: 'application_limit', endsAt: null } },
      },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();
    const text = el.querySelector('.sanction-active')!.textContent!;
    expect(text).toContain('moderation.sanctionActive.application_limit');
    expect(text).toContain('moderation.sanctionActive.forever');
  });

  it('constraints: at most 10', async () => {
    await create();
    const add = el.querySelector<HTMLButtonElement>('button.add-constraint')!;
    for (let i = 0; i < 10; i++) {
      add.click();
      await settle();
    }
    expect(el.querySelectorAll('input.constraint')).toHaveLength(10);
    expect(add.disabled).toBe(true);
  });
});
