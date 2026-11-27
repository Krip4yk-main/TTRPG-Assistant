import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { MeDto } from '@nri/shared';
import uk from '../../../assets/i18n/uk.json';
import { AuthStore } from '../../core/auth/auth.store';
import { SocketService } from '../../core/realtime/socket.service';
import { ThemeService } from '../../theming/theme.service';
import { TesterReport } from './tester-report';

const me: MeDto = {
  id: 1,
  publicId: 'tester0001',
  nickname: 'Тестер',
  avatarUrl: null,
  birthDate: '1990-01-01',
  role: 'user',
  status: 'active',
  timezone: 'Europe/Kyiv',
  locale: 'uk',
  uiTheme: 'neon-signs',
  availableThemes: ['neon-signs'],
  uiPrefs: { tearAnimation: true, sendAnimation: true },
  avatarSource: 'auto',
  customAvatarUrl: null,
  avatarOptions: [],
  identities: [],
};

describe('TesterReport', () => {
  let http: HttpTestingController;

  async function create(env: string, user: MeDto | null = null) {
    await TestBed.configureTestingModule({
      imports: [TesterReport],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService({ fallbackLang: 'uk' }),
        { provide: ThemeService, useValue: { theme: signal('neon-signs').asReadonly() } },
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            on: () => new Subject(),
            connected$: new Subject(),
            sessionLost$: new Subject(),
          },
        },
      ],
    }).compileComponents();
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('uk', uk);
    translate.use('uk');
    if (user) TestBed.inject(AuthStore).setMe(user);
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(TesterReport);
    fixture.componentRef.setInput('deployEnv', env);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  const overlay = () => document.querySelector('.cdk-overlay-container') as HTMLElement | null;
  const settle = async (fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  afterEach(() => {
    overlay()?.replaceChildren();
  });

  it.each(['local', 'prod'])('renders nothing on %s', async (env) => {
    const el = (await create(env)).nativeElement as HTMLElement;
    expect(el.querySelector('button')).toBeNull();
  });

  it('dev: a labelled button opens the dialog with the context shown', async () => {
    const fixture = await create('dev', me);
    const button = (fixture.nativeElement as HTMLElement).querySelector(
      'button.tester-report',
    ) as HTMLButtonElement;
    expect(button.textContent).toContain('Повідомити');
    expect(button.getAttribute('aria-label')).toBe('Повідомити про баг чи ідею');
    button.click();
    await settle(fixture);
    const dialog = overlay()!.querySelector('nri-tester-report-dialog') as HTMLElement;
    expect(dialog).not.toBeNull();
    const context = dialog.querySelector('.context')!.textContent!;
    expect(context).toContain('Додамо:');
    expect(context).toContain(location.pathname);
    expect(context).toContain('Неонові вивіски');
    expect(context).toContain(`${innerWidth}×${innerHeight}`);
    expect(context).toContain('tester0001');
    expect(
      [...dialog.querySelectorAll('mat-radio-button')].map((r) => r.textContent!.trim()),
    ).toEqual(['Баг', 'Ідея', 'Інше']);
  });

  it('dev: empty text is not sent; a report is sent with the context, then thanks', async () => {
    const fixture = await create('dev');
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button')!.click();
    await settle(fixture);
    const dialog = overlay()!.querySelector('nri-tester-report-dialog') as HTMLElement;
    const submit = dialog.querySelector<HTMLButtonElement>('button.submit')!;
    submit.click();
    await settle(fixture);
    http.expectNone('/api/tester-reports');
    expect(dialog.textContent).toContain('Опишіть, будь ласка, що сталося.');

    dialog.querySelector<HTMLElement>('[data-kind="idea"] input')!.click();
    const textarea = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.value = '  Додайте темну тему  ';
    textarea.dispatchEvent(new Event('input'));
    submit.click();
    await settle(fixture);
    const req = http.expectOne('/api/tester-reports');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      kind: 'idea',
      text: 'Додайте темну тему',
      context: {
        url: location.href.split('#')[0],
        theme: 'neon-signs',
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        userAgent: navigator.userAgent,
      },
    });
    req.flush({ id: 1 }, { status: 201, statusText: 'Created' });
    await settle(fixture);
    expect(dialog.querySelector('[role="status"]')?.textContent).toContain(
      'Дякуємо! Звіт надіслано.',
    );
    expect(dialog.querySelector('button.submit')).toBeNull();
  });

  it('dev: server error is shown in the dialog (rate limit)', async () => {
    const fixture = await create('dev');
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button')!.click();
    await settle(fixture);
    const dialog = overlay()!.querySelector('nri-tester-report-dialog') as HTMLElement;
    const textarea = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.value = 'Баг';
    textarea.dispatchEvent(new Event('input'));
    dialog.querySelector<HTMLButtonElement>('button.submit')!.click();
    await settle(fixture);
    http
      .expectOne('/api/tester-reports')
      .flush({ error: { code: 'RATE_LIMITED' } }, { status: 429, statusText: 'Too Many' });
    await settle(fixture);
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('Забагато спроб');
  });
});
