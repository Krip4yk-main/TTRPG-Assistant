import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Location } from '@angular/common';
import { SpyLocation, provideLocationMocks } from '@angular/common/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { Login } from './login';
import { SocketService } from '../../../core/realtime/socket.service';
import { AuthStore } from '../../../core/auth/auth.store';
import { runtimeConfig } from '../../../../environments/runtime-config';

describe('Login — banned account', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let location: SpyLocation;

  const settle = async () => {
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
  };
  const el = () => harness.routeNativeElement!;

  async function open(url: string, before?: () => void): Promise<Login> {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideLocationMocks(),
        provideRouter(
          [
            { path: 'login', component: Login },
            { path: '**', children: [] },
          ],
          withComponentInputBinding(),
        ),
        provideTranslateService(),
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
    });
    http = TestBed.inject(HttpTestingController);
    location = TestBed.inject(Location) as SpyLocation;
    before?.();
    harness = await RouterTestingHarness.create();
    document.body.appendChild(harness.fixture.nativeElement as HTMLElement);
    const login = await harness.navigateByUrl(url, Login);
    await settle();
    return login;
  }

  afterEach(() => {
    http.verify();
    (harness.fixture.nativeElement as HTMLElement).remove();
  });

  it('takes the OAuth appeal token from the query and replaces the URL without a history entry', async () => {
    await open('/login?error=ACCOUNT_BANNED&appeal=tok-xyz&returnTo=%2Fcalendar');
    const router = TestBed.inject(Router);
    expect(router.url).toBe('/login?returnTo=%2Fcalendar');
    expect(location.path()).not.toContain('tok-xyz');
    // Останній запис історії замінено (`replace:`), а не додано новий.
    expect(location.urlChanges.at(-1)).toBe('replace: /login?returnTo=%2Fcalendar');

    expect(el().querySelector('nri-banned-notice h1')!.textContent).toContain('banned.title');
    expect(el().querySelector<HTMLElement>('.nri-card[hidden]')).not.toBeNull();
    expect(el().querySelector('[role="alert"]')).toBeNull();

    el().querySelector<HTMLTextAreaElement>('textarea.message')!.value = 'Прошу переглянути';
    el().querySelector('textarea.message')!.dispatchEvent(new Event('input'));
    await settle();
    el().querySelector<HTMLButtonElement>('button.send')!.click();
    await settle();
    const req = http.expectOne('/api/appeals');
    expect(req.request.body).toEqual({ appealToken: 'tok-xyz', message: 'Прошу переглянути' });
    req.flush({ id: 1 }, { status: 201, statusText: 'Created' });
    await settle();
    expect(el().querySelector('.state-title')!.textContent).toContain('banned.sent.title');
  });

  it('a stray appeal param is removed even without the banned error', async () => {
    await open('/login?appeal=tok-xyz');
    expect(TestBed.inject(Router).url).toBe('/login');
    expect(el().querySelector('nri-banned-notice')).toBeNull();
  });

  it('dev/telegram login: ACCOUNT_BANNED with details shows the notice (appealSent respected)', async () => {
    const login = await open('/login');
    const c = login as unknown as {
      devForm: { setValue(v: { nickname: string; ownerKey: string }): void };
      devLogin(): Promise<void>;
    };
    c.devForm.setValue({ nickname: 'Bilbo', ownerKey: '' });
    const done = c.devLogin();
    http
      .expectOne('/api/auth/dev-login')
      .flush(
        { error: { code: 'ACCOUNT_BANNED', details: { appealToken: 'tok-2', appealSent: true } } },
        { status: 403, statusText: 'Forbidden' },
      );
    await done;
    await settle();
    expect(el().querySelector('nri-banned-notice')).not.toBeNull();
    expect(el().querySelector('.state-title')!.textContent).toContain('banned.sent.title');
    expect(el().querySelector('nri-banned-notice form')).toBeNull();
  });

  it('back from the expired state returns to the login card', async () => {
    await open('/login?error=ACCOUNT_BANNED&appeal=tok-old');
    el().querySelector<HTMLTextAreaElement>('textarea.message')!.value = 'Текст';
    el().querySelector('textarea.message')!.dispatchEvent(new Event('input'));
    await settle();
    el().querySelector<HTMLButtonElement>('button.send')!.click();
    await settle();
    http
      .expectOne('/api/appeals')
      .flush({ error: { code: 'UNAUTHENTICATED' } }, { status: 401, statusText: 'x' });
    await settle();
    expect(el().querySelector('.state-title')!.textContent).toContain('banned.expired.title');
    el().querySelector<HTMLButtonElement>('button.back')!.click();
    await settle();
    expect(el().querySelector('nri-banned-notice')).toBeNull();
    expect(el().querySelector('.nri-card[hidden]')).toBeNull();
    expect(document.activeElement).toBe(el().querySelector('.nri-card h1'));
  });

  it('OAuth `sent=1` shows the sent state; sent is removed from the URL too', async () => {
    await open('/login?error=ACCOUNT_BANNED&appeal=tok-s&sent=1');
    expect(TestBed.inject(Router).url).toBe('/login');
    expect(location.urlChanges.at(-1)).toBe('replace: /login');
    expect(el().querySelector('.state-title')!.textContent).toContain('banned.sent.title');
    expect(el().querySelector('nri-banned-notice form')).toBeNull();
  });

  it('OAuth `appealStatus` shows the appeal decision; it is removed from the URL too', async () => {
    await open('/login?error=ACCOUNT_BANNED&appeal=tok-s&sent=1&appealStatus=rejected');
    expect(TestBed.inject(Router).url).toBe('/login');
    const line = el().querySelector('nri-banned-notice .appeal-status')!;
    expect(line.getAttribute('data-status')).toBe('rejected');
    expect(line.textContent).toContain('banned.status.rejected');
  });

  it('ACCOUNT_BANNED details with appealStatus show the decision on the ban screen', async () => {
    await open('/login', () =>
      TestBed.inject(AuthStore).accountBanned({
        appealToken: 'tok-a',
        appealSent: true,
        appealStatus: 'accepted',
      }),
    );
    expect(el().querySelector('nri-banned-notice .appeal-status')!.textContent).toContain(
      'banned.status.accepted',
    );
  });

  it('mid-session ban: takes the in-memory appeal details and clears the error from the URL', async () => {
    await open('/login?error=ACCOUNT_BANNED&returnTo=%2Fcalendar', () =>
      TestBed.inject(AuthStore).accountBanned({ appealToken: 'tok-m', appealSent: false }),
    );
    const auth = TestBed.inject(AuthStore);
    expect(auth.pendingBan()).toBeNull();
    expect(TestBed.inject(Router).url).toBe('/login?returnTo=%2Fcalendar');
    expect(el().querySelector('nri-banned-notice h1')).not.toBeNull();
    el().querySelector<HTMLTextAreaElement>('textarea.message')!.value = 'Чому?';
    el().querySelector('textarea.message')!.dispatchEvent(new Event('input'));
    await settle();
    el().querySelector<HTMLButtonElement>('button.send')!.click();
    await settle();
    const req = http.expectOne('/api/appeals');
    expect(req.request.body).toEqual({ appealToken: 'tok-m', message: 'Чому?' });
    req.flush({ id: 1 }, { status: 201, statusText: 'Created' });
  });
});

describe('Login — Discord', () => {
  const config = runtimeConfig as { discordLogin: boolean };
  const initial = config.discordLogin;

  async function render(flag: boolean): Promise<HTMLElement> {
    config.discordLogin = flag;
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
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
    });
    const fixture = TestBed.createComponent(Login);
    fixture.componentRef.setInput('returnTo', '/calendar');
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => {
    config.discordLogin = initial;
  });

  it('no Discord button while the flag is off', async () => {
    const el = await render(false);
    expect(el.querySelector('a.discord')).toBeNull();
  });

  it('with the flag on: a Discord button to the OAuth start that keeps returnTo', async () => {
    const el = await render(true);
    const link = el.querySelector<HTMLAnchorElement>('a.discord')!;
    expect(link.textContent).toContain('login.discord');
    expect(link.getAttribute('href')).toBe(
      '/api/auth/discord/start?mode=login&returnTo=%2Fcalendar',
    );
    expect(el.textContent).not.toContain('login.noProviders');
  });
});

describe('Login — dev-login mode', () => {
  async function render(mode: 'local' | 'beta' | 'off'): Promise<HTMLElement> {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
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
    });
    const fixture = TestBed.createComponent(Login);
    fixture.componentRef.setInput('mode', mode);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('local: the dev form is on /login', async () => {
    const el = await render('local');
    expect(el.querySelector('form.dev-login')).not.toBeNull();
  });

  it.each(['beta', 'off'] as const)('%s: no dev form and no hint about it on /login', async (m) => {
    const el = await render(m);
    expect(el.querySelector('form.dev-login')).toBeNull();
    expect(el.textContent).not.toContain('login.dev.');
    expect(el.querySelector('a[href*="login/dev"]')).toBeNull();
  });
});
