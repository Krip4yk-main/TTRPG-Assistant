import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { APPEAL_MESSAGE_MAX } from '@nri/shared';
import { BannedNotice } from './banned-notice';

describe('BannedNotice', () => {
  let fixture: ComponentFixture<BannedNotice>;
  let http: HttpTestingController;
  let el: HTMLElement;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create(appealSent = false) {
    await TestBed.configureTestingModule({
      imports: [BannedNotice],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideTranslateService()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(BannedNotice);
    fixture.componentRef.setInput('appealToken', 'tok-1');
    fixture.componentRef.setInput('appealSent', appealSent);
    el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle();
  }

  afterEach(() => {
    http.verify();
    el.remove();
  });

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
  const stateTitle = () => el.querySelector('.state-title')!.textContent!.trim();

  it('shows the banned heading (focused) and a labelled message form with a counter', async () => {
    await create();
    const h1 = el.querySelector('h1')!;
    expect(h1.textContent).toContain('banned.title');
    expect(document.activeElement).toBe(h1);
    expect(el.querySelector('mat-label')!.textContent).toContain('banned.form.message');
    // Зміну стану оголошує перенесення фокуса, а не live-регіон (без подвійного читання).
    expect(el.querySelector('.state')!.hasAttribute('aria-live')).toBe(false);
    expect(el.querySelector('textarea')!.getAttribute('maxlength')).toBe(
      String(APPEAL_MESSAGE_MAX),
    );
    expect(el.querySelector('.counter')).not.toBeNull();
  });

  it('sends the trimmed message with the token and shows «already sent»', async () => {
    await create();
    await type('  Це помилка  ');
    await submit();
    const req = http.expectOne('/api/appeals');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ appealToken: 'tok-1', message: 'Це помилка' });
    req.flush({ id: 3 }, { status: 201, statusText: 'Created' });
    await settle();
    expect(stateTitle()).toBe('banned.sent.title');
    expect(el.querySelector('form')).toBeNull();
    expect(document.activeElement).toBe(el.querySelector('.state-title'));
  });

  it('409 APPEAL_EXISTS shows «already sent»', async () => {
    await create();
    await type('Ще раз');
    await submit();
    http
      .expectOne('/api/appeals')
      .flush({ error: { code: 'APPEAL_EXISTS' } }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(stateTitle()).toBe('banned.sent.title');
  });

  it('appealSent=true shows the sent state immediately, without a form', async () => {
    await create(true);
    expect(stateTitle()).toBe('banned.sent.title');
    expect(el.querySelector('form')).toBeNull();
  });

  it('validates the message: empty/whitespace and over the limit are not sent', async () => {
    await create();
    await submit();
    expect(el.querySelector('mat-error')!.textContent).toContain('banned.form.required');
    await type('   ');
    await submit();
    expect(el.querySelector('mat-error')!.textContent).toContain('banned.form.required');
    // Атрибут maxlength обмежує введення; валідатор — на випадок, якщо його обійдуть.
    await type('я'.repeat(APPEAL_MESSAGE_MAX + 1));
    await submit();
    expect(el.querySelector('mat-error')!.textContent).toContain('banned.form.tooLong');
    http.expectNone('/api/appeals');

    await type('я'.repeat(APPEAL_MESSAGE_MAX));
    await submit();
    http.expectOne('/api/appeals').flush({ id: 1 }, { status: 201, statusText: 'Created' });
    await settle();
    expect(stateTitle()).toBe('banned.sent.title');
  });

  it('invalid/expired token (401) and unbanned (403) explain the link expired; back emits', async () => {
    await create();
    const back = vi.fn();
    fixture.componentInstance.back.subscribe(back);
    await type('Текст');
    await submit();
    http
      .expectOne('/api/appeals')
      .flush({ error: { code: 'UNAUTHENTICATED' } }, { status: 401, statusText: 'x' });
    await settle();
    expect(stateTitle()).toBe('banned.expired.title');
    expect(document.activeElement).toBe(el.querySelector('.state-title'));
    el.querySelector<HTMLButtonElement>('button.back')!.click();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('403 also shows the expired state', async () => {
    await create();
    await type('Текст');
    await submit();
    http
      .expectOne('/api/appeals')
      .flush({ error: { code: 'FORBIDDEN' } }, { status: 403, statusText: 'x' });
    await settle();
    expect(stateTitle()).toBe('banned.expired.title');
  });

  it('429 RATE_LIMITED and 403 CSRF are retryable: form and text stay, inline error', async () => {
    await create();
    await type('Текст');
    await submit();
    http
      .expectOne('/api/appeals')
      .flush({ error: { code: 'RATE_LIMITED' } }, { status: 429, statusText: 'x' });
    await settle();
    expect(el.querySelector('.send-error')!.textContent).toContain('errors.RATE_LIMITED');
    expect(el.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Текст');
    expect(stateTitle()).toBe('banned.form.title');

    await submit();
    http
      .expectOne('/api/appeals')
      .flush({ error: { code: 'CSRF' } }, { status: 403, statusText: 'x' });
    await settle();
    expect(el.querySelector('.send-error')!.textContent).toContain('errors.CSRF');
    expect(el.querySelector('form')).not.toBeNull();
  });

  it('a server error keeps the form with the text and allows retrying', async () => {
    await create();
    await type('Текст');
    await submit();
    http
      .expectOne('/api/appeals')
      .flush({ error: { code: 'INTERNAL' } }, { status: 500, statusText: 'x' });
    await settle();
    expect(el.querySelector('.send-error')!.textContent).toContain('banned.form.sendError');
    expect(el.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Текст');
    await submit();
    http.expectOne('/api/appeals').flush({ id: 2 }, { status: 201, statusText: 'Created' });
    await settle();
    expect(stateTitle()).toBe('banned.sent.title');
  });
});
