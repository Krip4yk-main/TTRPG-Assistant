import { LiveAnnouncer } from '@angular/cdk/a11y';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideRouter } from '@angular/router';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import type { ApplicationDto, MeDto } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { Subject } from 'rxjs';
import { SocketService } from '../../../core/realtime/socket.service';
import { ThemeService } from '../../../theming/theme.service';
import { browserTimeZone, formatDateTime, formatTime } from '../../../core/i18n/dates';
import { ApplyDialog, type ApplyDialogData } from './apply-dialog';
import { TEST_NOW } from '../../../../testing/test-now';

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
  let ref: { close: ReturnType<typeof vi.fn>; disableClose?: boolean };
  let el: HTMLElement;
  let announce: ReturnType<typeof vi.fn>;
  /** Ефекти дизайну: справжній ThemeService покритий своїм спеком (вимкнення, тайм-аут). */
  let themes: {
    preloadEffect: ReturnType<typeof vi.fn>;
    playEffect: ReturnType<
      typeof vi.fn<(name: string, source: HTMLElement, onStart?: () => void) => Promise<void>>
    >;
  };

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create(d: ApplyDialogData = data) {
    close = vi.fn();
    ref = { close };
    themes = { preloadEffect: vi.fn(), playEffect: vi.fn(async () => {}) };
    announce = vi.fn(async () => {});
    await TestBed.configureTestingModule({
      imports: [ApplyDialog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        provideRouter([{ path: '**', children: [] }]),
        { provide: MAT_DIALOG_DATA, useValue: d },
        { provide: MatDialogRef, useValue: ref },
        { provide: ThemeService, useValue: themes },
        { provide: LiveAnnouncer, useValue: { announce } },
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            on: () => new Subject(),
            sessionLost$: new Subject(),
          },
        },
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

  it('renders each question as a plain label tied to its field, not a floating mat-label', async () => {
    await create({ ...data, questions: ['Перше питання?', 'Друге питання?'] });
    const labels = el.querySelectorAll<HTMLLabelElement>('label.question');
    expect(labels).toHaveLength(2);
    expect(labels[1].textContent).toContain('Друге питання?');
    const area = el.querySelectorAll<HTMLTextAreaElement>('textarea.answer')[1];
    expect(labels[1].htmlFor).toBe(area.id);
    expect(el.querySelector('mat-form-field mat-label')?.textContent ?? '').not.toContain(
      'Перше питання?',
    );
  });

  it('no game safety info: no safety section', async () => {
    await create();
    expect(el.querySelector('section.safety')).toBeNull();
  });

  it('shows the game safety info briefly when the GM filled it', async () => {
    await create({
      ...data,
      safety: {
        tools: ['x_card'],
        lines: { slugs: [], custom: ['Павуки'] },
        veils: { slugs: ['gore'], custom: [] },
      },
    });
    const section = el.querySelector<HTMLElement>('section.safety')!;
    expect(section.textContent).toContain('games.safety.title');
    expect(section.textContent).toContain('games.safety.tool.x_card.label');
    expect(section.textContent).toContain('Павуки');
    expect(section.querySelector('[data-kind="veils"] nri-warning-chip')).not.toBeNull();
  });

  it('your limits are marked as visible to the GM only', async () => {
    await create();
    expect(el.querySelector('.private-note')!.textContent).toContain(
      'games.applications.apply.constraintsPrivate',
    );
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
    // Без ефекту дизайну (playEffect завершується одразу) — закривається одразу ж.
    await vi.waitFor(() =>
      expect(close).toHaveBeenCalledWith({ status: 'applied', application: created }),
    );
    // Ефект не грав — закриття не блокувалось, озвучує сама сторінка.
    expect(announce).not.toHaveBeenCalled();
    expect(ref.disableClose).toBeFalsy();
  });

  it('preloads the design «sent» effect when opened', async () => {
    await create();
    expect(themes.preloadEffect).toHaveBeenCalledWith('applicationSent');
    expect(themes.playEffect).not.toHaveBeenCalled();
  });

  it('on success plays the design effect once, then closes (no Escape while it plays)', async () => {
    await create();
    let finish!: () => void;
    themes.playEffect.mockImplementation((_name, _source, onStart) => {
      onStart?.();
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await accept();
    await type('textarea.answer', 'Багато');
    await submit();
    http
      .expectOne('/api/games/7/applications')
      .flush(created, { status: 201, statusText: 'Created' });
    await settle();
    expect(themes.playEffect).toHaveBeenCalledTimes(1);
    expect(themes.playEffect.mock.calls[0]![0]).toBe('applicationSent');
    expect(themes.playEffect.mock.calls[0]![1]).toBeInstanceOf(HTMLElement);
    expect(ref.disableClose).toBe(true);
    // Оверлей ефекту декоративний: про успіх повідомляє ввічливий live-регіон на старті.
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('games.applications.apply.sent', 'polite');
    expect(close).not.toHaveBeenCalled();
    finish();
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
    // Сторінка не озвучує своє повідомлення вдруге.
    expect(close).toHaveBeenCalledWith({
      status: 'applied',
      application: created,
      announced: true,
    });
  });

  it('while the effect plays, «Скасувати» is a no-op and the dialog is inert: it still closes with the success', async () => {
    await create();
    let finish!: () => void;
    themes.playEffect.mockImplementation((_name, _source, onStart) => {
      onStart?.();
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await accept();
    await type('textarea.answer', 'Багато');
    await submit();
    http
      .expectOne('/api/games/7/applications')
      .flush(created, { status: 201, statusText: 'Created' });
    await settle();
    const source = themes.playEffect.mock.calls[0]![1];
    expect(source.inert).toBe(true);
    const cancel = Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('common.cancel'),
    )!;
    cancel.click();
    await settle();
    expect(close).not.toHaveBeenCalled();
    finish();
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith({
      status: 'applied',
      application: created,
      announced: true,
    });
  });

  it('an API error plays no effect and keeps the form filled', async () => {
    await create();
    await accept();
    await type('textarea.answer', 'Багато');
    await submit();
    http
      .expectOne('/api/games/7/applications')
      .flush({ error: { code: 'GM_BLACKLISTED' } }, { status: 403, statusText: 'Forbidden' });
    await settle();
    expect(themes.playEffect).not.toHaveBeenCalled();
    expect(ref.disableClose).toBeFalsy();
    expect(el.querySelector<HTMLTextAreaElement>('textarea.answer')!.value).toBe('Багато');
    expect(close).not.toHaveBeenCalled();
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

  describe('409 APPLICATION_COOLDOWN', () => {
    // Лише `Date` — таймери Angular лишаються справжніми.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(TEST_NOW));
    });
    afterEach(() => vi.useRealTimers());

    async function cooldown(retryAt: string): Promise<string> {
      await create();
      const translate = TestBed.inject(TranslateService);
      translate.setTranslation('uk', {
        errors: { APPLICATION_COOLDOWN: 'Спробуйте після {{time}}.' },
      });
      translate.use('uk');
      await accept();
      await type('textarea.answer', 'Багато');
      await submit();
      http
        .expectOne('/api/games/7/applications')
        .flush(
          { error: { code: 'APPLICATION_COOLDOWN', details: { retryAt } } },
          { status: 409, statusText: 'Conflict' },
        );
      await settle();
      expect(close).not.toHaveBeenCalled();
      return el.querySelector('[role="alert"]')!.textContent!;
    }

    it('same day: only HH:mm in the viewer zone', async () => {
      const retryAt = new Date(TEST_NOW + 10 * 60_000).toISOString();
      const text = await cooldown(retryAt);
      const time = formatTime(retryAt, browserTimeZone());
      expect(time).toMatch(/^\d\d:\d\d$/);
      expect(text).toContain(`Спробуйте після ${time}.`);
    });

    it('another day (after a rejection): date and time', async () => {
      const retryAt = new Date(TEST_NOW + 23.5 * 3_600_000).toISOString();
      const text = await cooldown(retryAt);
      const when = formatDateTime(retryAt, browserTimeZone());
      expect(when).not.toBe(formatTime(retryAt, browserTimeZone()));
      expect(text).toContain(`Спробуйте після ${when}.`);
    });
  });

  it('409 APPLICATION_COOLDOWN without a valid retryAt falls back to «a bit later»', async () => {
    await create();
    await accept();
    await type('textarea.answer', 'Багато');
    await submit();
    http
      .expectOne('/api/games/7/applications')
      .flush(
        { error: { code: 'APPLICATION_COOLDOWN', details: {} } },
        { status: 409, statusText: 'Conflict' },
      );
    await settle();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain(
      'games.applications.apply.cooldownSoon',
    );
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
  it('my limits: button is hidden without saved limits', async () => {
    await create();
    expect(el.querySelector('button.insert-my-limits')).toBeNull();
  });

  it('my limits: appends without duplicates, never submits automatically', async () => {
    await create();
    TestBed.inject(AuthStore).setMe({
      id: 1,
      status: 'active',
      timezone: 'Europe/Kyiv',
      myLimits: ['Без павуків', 'Без крові'],
    } as unknown as MeDto);
    await settle();
    el.querySelector<HTMLButtonElement>('button.add-constraint')!.click();
    await settle();
    await type('input.constraint', 'Без павуків');
    el.querySelector<HTMLButtonElement>('button.insert-my-limits')!.click();
    await settle();
    el.querySelector<HTMLButtonElement>('button.insert-my-limits')!.click();
    await settle();
    const values = [...el.querySelectorAll<HTMLInputElement>('input.constraint')].map(
      (i) => i.value,
    );
    expect(values).toEqual(['Без павуків', 'Без крові']);
    // Перший клік додав одну межу, другий — нічого; обидва озвучені.
    expect(announce).toHaveBeenNthCalledWith(1, 'myLimits.inserted', 'polite');
    expect(announce).toHaveBeenCalledTimes(2);
    http.expectNone('/api/games/7/applications');
    expect(close).not.toHaveBeenCalled();
  });

  it('my limits: fills empty rows first instead of leaving blank required ones', async () => {
    await create();
    TestBed.inject(AuthStore).setMe({
      id: 1,
      status: 'active',
      timezone: 'Europe/Kyiv',
      myLimits: ['Без павуків', 'Без крові'],
    } as unknown as MeDto);
    await settle();
    el.querySelector<HTMLButtonElement>('button.add-constraint')!.click();
    await settle();
    el.querySelector<HTMLButtonElement>('button.insert-my-limits')!.click();
    await settle();
    const values = [...el.querySelectorAll<HTMLInputElement>('input.constraint')].map(
      (i) => i.value,
    );
    expect(values).toEqual(['Без павуків', 'Без крові']);
    expect(announce).toHaveBeenCalledWith('myLimits.inserted', 'polite');
  });
});
