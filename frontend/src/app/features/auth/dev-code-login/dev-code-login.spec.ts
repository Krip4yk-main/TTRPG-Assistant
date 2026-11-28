import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { DevCodeLogin } from './dev-code-login';
import { AuthApi } from '../../../core/auth/auth.api';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';
import { routes } from '../../../app.routes';
import { devLoginMode } from '../../../../environments/runtime-config';

describe('DevCodeLogin', () => {
  let http: HttpTestingController;
  let el: HTMLElement;
  let fixture: ReturnType<typeof TestBed.createComponent<DevCodeLogin>>;

  async function render(): Promise<void> {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
        {
          // Тести збираються в режимі local, де реальний AuthApi.devCodeLogin вимкнено: підміна.
          provide: AuthApi,
          useFactory: () => {
            const client = TestBed.inject(HttpClient);
            return { devCodeLogin: (b: unknown) => client.post('/api/auth/dev-login/code', b) };
          },
        },
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
    fixture = TestBed.createComponent(DevCodeLogin);
    fixture.detectChanges();
    await fixture.whenStable();
    el = fixture.nativeElement as HTMLElement;
  }

  const type = (name: string, value: string) => {
    const input = el.querySelector<HTMLInputElement>(`input[formControlName="${name}"]`)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  const submit = async () => {
    el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
  };
  const fail = async (status: number, code: string) => {
    http
      .expectOne('/api/auth/dev-login/code')
      .flush({ error: { code } }, { status, statusText: 'x' });
    await fixture.whenStable();
    fixture.detectChanges();
  };

  afterEach(() => http.verify());

  it('renders code (password) and nick fields with labels', async () => {
    await render();
    expect(el.querySelector('input[formControlName="code"]')!.getAttribute('type')).toBe(
      'password',
    );
    expect(el.querySelector('input[formControlName="nickname"]')).not.toBeNull();
    expect(el.querySelectorAll('mat-label').length).toBe(2);
  });

  it('does not send an invalid form: required and nick format errors', async () => {
    await render();
    await submit();
    expect(el.querySelectorAll('mat-error').length).toBe(2);
    type('code', 'secret');
    type('nickname', 'a b');
    await submit();
    expect(el.textContent).toContain('profile.errors.NICKNAME_FORMAT');
  });

  it('sends code and trimmed nick, signs in and navigates', async () => {
    await render();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const setMe = vi.spyOn(TestBed.inject(AuthStore), 'setMe');
    type('code', 'secret-code');
    type('nickname', ' Tester_1 ');
    await submit();
    const req = http.expectOne('/api/auth/dev-login/code');
    expect(req.request.body).toEqual({ code: 'secret-code', nickname: 'Tester_1' });
    req.flush({ user: { id: 1, status: 'active' } });
    await fixture.whenStable();
    expect(setMe).toHaveBeenCalled();
    expect(nav).toHaveBeenCalledWith('/');
  });

  it.each([
    [403, 'FORBIDDEN', 'login.devCode.errors.FORBIDDEN'],
    [429, 'RATE_LIMITED', 'login.devCode.errors.RATE_LIMITED'],
    [409, 'NICKNAME_TAKEN', 'login.devCode.errors.NICKNAME_TAKEN'],
    [400, 'VALIDATION', 'login.devCode.errors.VALIDATION'],
    [500, 'INTERNAL', 'errors.INTERNAL'],
  ])('%i %s shows %s in an alert', async (status, code, key) => {
    await render();
    type('code', 'x');
    type('nickname', 'Tester_1');
    await submit();
    await fail(status, code);
    expect(el.querySelector('[role="alert"]')!.textContent).toContain(key);
  });

  it('banned account shows the appeal notice', async () => {
    await render();
    type('code', 'x');
    type('nickname', 'Tester_1');
    await submit();
    http
      .expectOne('/api/auth/dev-login/code')
      .flush(
        { error: { code: 'ACCOUNT_BANNED', details: { appealToken: 't', appealSent: false } } },
        { status: 403, statusText: 'x' },
      );
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('nri-banned-notice')).not.toBeNull();
  });
});

describe('dev-code-login route', () => {
  it('is mounted in app routes only in the beta mode (tests build as local: absent)', () => {
    const route = routes.find((r) => r.path === 'login/dev');
    expect(route !== undefined).toBe(devLoginMode === 'beta');
    expect(routes.some((r) => r.path === 'login')).toBe(true);
    if (route) {
      expect(route.data?.['noindex']).toBe(true);
      expect(route.canActivate?.length).toBe(1);
    }
  });
});

describe('AuthApi dev-login gating', () => {
  it('the endpoint of another mode is refused client-side without any request', async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const api = TestBed.inject(AuthApi);
    const http = TestBed.inject(HttpTestingController);
    // Тести — режим local: dev-вхід за кодом заборонено, а звичайний dev-вхід дозволений.
    expect(devLoginMode).toBe('local');
    await expect(
      new Promise((resolve, reject) =>
        api.devCodeLogin({ code: 'c', nickname: 'Tester_1' }).subscribe({
          next: resolve,
          error: reject,
        }),
      ),
    ).rejects.toThrow();
    http.verify();
  });
});
