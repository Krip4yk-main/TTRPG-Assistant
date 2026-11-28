import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { MeDto } from '@nri/shared';
import { AccountSettings } from './account-settings';
import { AuthStore } from '../../../core/auth/auth.store';
import { browserZone } from '../../../core/i18n/dates';
import { SocketService } from '../../../core/realtime/socket.service';
import { PublicConfigStore } from '../../../core/config/public-config.store';

const me: MeDto = {
  id: 1,
  publicId: 'abcdefghjk',
  nickname: 'Gandalf',
  avatarUrl: null,
  birthDate: '1990-01-01',
  role: 'user',
  status: 'active',
  timezone: 'Europe/Kyiv',
  locale: 'uk',
  uiTheme: 'quest-board',
  availableThemes: ['quest-board'],
  uiPrefs: { tearAnimation: true, sendAnimation: true },
  myLimits: [],
  defaultView: 'player',
  avatarSource: 'auto',
  customAvatarUrl: null,
  avatarOptions: [],
  identities: [{ provider: 'dev', displayName: 'G' }],
};

describe('AccountSettings nickname', () => {
  let fixture: ComponentFixture<AccountSettings>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let auth: AuthStore;

  const input = () => el.querySelector<HTMLInputElement>('input[name="nickname"]')!;
  const form = () => el.querySelector<HTMLFormElement>('form.nickname')!;
  const type = async (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AccountSettings],
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
    }).compileComponents();
    auth = TestBed.inject(AuthStore);
    auth.setMe(me);
    fixture = TestBed.createComponent(AccountSettings);
    http = TestBed.inject(HttpTestingController);
    el = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
    http.expectOne('/api/me/settings').flush({ calendarAutoBusy: true });
    await fixture.whenStable();
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  it('prefills the current nickname; saving PATCHes and updates AuthStore.me()', async () => {
    expect(input().value).toBe('Gandalf');
    await type('Saruman');
    form().dispatchEvent(new Event('submit'));
    const req = http.expectOne('/api/me/nickname');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ nickname: 'Saruman' });
    req.flush({ ...me, nickname: 'Saruman' });
    await fixture.whenStable();
    expect(auth.me()?.nickname).toBe('Saruman');
    expect(auth.me()?.publicId).toBe('abcdefghjk');
  });

  it('invalid nickname is not sent and shows a format error', async () => {
    await type('a!');
    form().dispatchEvent(new Event('submit'));
    http.expectNone('/api/me/nickname');
    expect(el.textContent).toContain('profile.errors.NICKNAME_FORMAT');
  });

  it('409 NICKNAME_TAKEN shows the error next to the field', async () => {
    await type('Saruman');
    form().dispatchEvent(new Event('submit'));
    http
      .expectOne('/api/me/nickname')
      .flush({ error: { code: 'NICKNAME_TAKEN' } }, { status: 409, statusText: 'Conflict' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).toContain('profile.errors.NICKNAME_TAKEN');
    expect(auth.me()?.nickname).toBe('Gandalf');
  });

  it('birth-date form submit PATCHes /api/me/birth-date with the ISO date', async () => {
    const bdForm = el.querySelector<HTMLFormElement>('form.birth-date:not(.nickname)')!;
    const bd = el.querySelector<HTMLInputElement>('form.birth-date:not(.nickname) input')!;
    bd.value = '02.03.1991';
    bd.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
    bdForm.dispatchEvent(new Event('submit'));
    const req = http.expectOne('/api/me/birth-date');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ birthDate: '1991-03-02' });
    req.flush({ ...me, birthDate: '1991-03-02' });
    await fixture.whenStable();
    expect(auth.me()?.birthDate).toBe('1991-03-02');
  });

  it('birth-date 409 BIRTH_DATE_COOLDOWN shows the cooldown message', async () => {
    const bdForm = el.querySelector<HTMLFormElement>('form.birth-date:not(.nickname)')!;
    const bd = el.querySelector<HTMLInputElement>('form.birth-date:not(.nickname) input')!;
    bd.value = '02.03.1991';
    bd.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
    bdForm.dispatchEvent(new Event('submit'));
    http.expectOne('/api/me/birth-date').flush(
      {
        error: {
          code: 'BIRTH_DATE_COOLDOWN',
          details: { availableAt: '2027-01-01T00:00:00.000Z' },
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).toContain('profile.errors.BIRTH_DATE_COOLDOWN');
  });

  describe('calendar auto busy', () => {
    const toggle = () => el.querySelector<HTMLButtonElement>('.auto-busy button[role=switch]')!;

    it('shows the setting (on by default) and PATCHes on change', async () => {
      fixture.detectChanges();
      expect(toggle().getAttribute('aria-checked')).toBe('true');
      toggle().click();
      fixture.detectChanges();
      const req = http.expectOne('/api/me/settings');
      expect(req.request.method).toBe('PATCH');
      expect(req.request.body).toEqual({ calendarAutoBusy: false });
      req.flush({ calendarAutoBusy: false });
      await fixture.whenStable();
      fixture.detectChanges();
      expect(toggle().getAttribute('aria-checked')).toBe('false');
      expect(el.querySelector('.auto-busy')!.textContent).toContain('account.calendar.saved');
    });

    it('a failed PATCH reverts the toggle and shows the error', async () => {
      fixture.detectChanges();
      toggle().click();
      fixture.detectChanges();
      http
        .expectOne('/api/me/settings')
        .flush({ error: { code: 'INTERNAL' } }, { status: 500, statusText: 'Server Error' });
      await fixture.whenStable();
      fixture.detectChanges();
      expect(toggle().getAttribute('aria-checked')).toBe('true');
      expect(el.querySelector('.auto-busy [role=alert]')!.textContent).toContain('errors.INTERNAL');
    });
  });

  describe('default view', () => {
    const select = () => el.querySelector<HTMLElement>('.default-view mat-select')!;
    const pick = async (label: string) => {
      fixture.detectChanges();
      select().querySelector<HTMLElement>('.mat-mdc-select-trigger')!.click();
      fixture.detectChanges();
      await fixture.whenStable();
      const panel = document.getElementById(select().getAttribute('aria-controls')!)!;
      const options = [...panel.querySelectorAll<HTMLElement>('mat-option')];
      expect(options.map((o) => o.textContent!.trim())).toEqual([
        'shell.viewMode.player',
        'shell.viewMode.gm',
      ]);
      options.find((o) => o.textContent!.trim() === label)!.click();
      fixture.detectChanges();
      await fixture.whenStable();
    };

    it('shows the saved default; picking another PATCHes /api/me/default-view and refreshes me()', async () => {
      fixture.detectChanges();
      expect(select().textContent).toContain('shell.viewMode.player');
      await pick('shell.viewMode.gm');
      const req = http.expectOne('/api/me/default-view');
      expect(req.request.method).toBe('PATCH');
      expect(req.request.body).toEqual({ defaultView: 'gm' });
      req.flush({ ...me, defaultView: 'gm' });
      await fixture.whenStable();
      fixture.detectChanges();
      expect(auth.me()?.defaultView).toBe('gm');
      expect(el.querySelector('.default-view')!.textContent).toContain('account.defaultView.saved');
    });

    it('a failed PATCH reverts the choice and shows the error', async () => {
      await pick('shell.viewMode.gm');
      http
        .expectOne('/api/me/default-view')
        .flush({ error: { code: 'INTERNAL' } }, { status: 500, statusText: 'Server Error' });
      await fixture.whenStable();
      fixture.detectChanges();
      expect(select().textContent).toContain('shell.viewMode.player');
      expect(auth.me()?.defaultView).toBe('player');
      expect(el.querySelector('.default-view [role=alert]')!.textContent).toContain(
        'errors.INTERNAL',
      );
    });
  });

  describe('time zone', () => {
    const tzInput = () =>
      el.querySelector<HTMLInputElement>('form.timezone input[name="timezone"]')!;
    const tzForm = () => el.querySelector<HTMLFormElement>('form.timezone')!;
    const typeTz = async (value: string) => {
      tzInput().value = value;
      tzInput().dispatchEvent(new Event('input'));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };

    it('prefills the account zone; saving PATCHes /api/me/timezone and refreshes AuthStore.me()', async () => {
      fixture.detectChanges();
      expect(tzInput().value).toBe('Europe/Kyiv');
      // Пояснення: слоти календаря лишаються тим самим «настінним» часом.
      expect(el.textContent).toContain('account.timezone.hint');
      await typeTz('America/New_York');
      tzForm().dispatchEvent(new Event('submit'));
      const req = http.expectOne('/api/me/timezone');
      expect(req.request.method).toBe('PATCH');
      expect(req.request.body).toEqual({ timezone: 'America/New_York' });
      req.flush({ ...me, timezone: 'America/New_York' });
      await fixture.whenStable();
      fixture.detectChanges();
      expect(auth.me()?.timezone).toBe('America/New_York');
      expect(el.textContent).toContain('account.timezone.saved');
    });

    it('an invalid zone is not sent and shows an error', async () => {
      fixture.detectChanges();
      await typeTz('Nope/Zone');
      tzInput().dispatchEvent(new Event('blur'));
      tzForm().dispatchEvent(new Event('submit'));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      http.expectNone('/api/me/timezone');
      expect(el.textContent).toContain('profile.errors.TIMEZONE');
    });

    it('a blocked zone is not sent and shows an error', async () => {
      fixture.detectChanges();
      await typeTz('Europe/Moscow');
      tzInput().dispatchEvent(new Event('blur'));
      tzForm().dispatchEvent(new Event('submit'));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      http.expectNone('/api/me/timezone');
      expect(el.textContent).toContain('profile.errors.TIMEZONE');
    });

    const recreate = async () => {
      fixture = TestBed.createComponent(AccountSettings);
      el = fixture.nativeElement as HTMLElement;
      fixture.detectChanges();
      await fixture.whenStable();
      http.expectOne('/api/me/settings').flush({ calendarAutoBusy: true });
      await fixture.whenStable();
    };

    it('offers the device zone when it differs', async () => {
      vi.spyOn(browserZone, 'get').mockReturnValue('Asia/Tokyo');
      await recreate();
      const useDevice = el.querySelector<HTMLButtonElement>('button.use-device-tz')!;
      expect(useDevice.textContent).toContain('account.timezone.useDevice');
      useDevice.click();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(tzInput().value).toBe('Asia/Tokyo');
      http.expectNone('/api/me/timezone');
    });

    it('a blocked device zone is not offered', async () => {
      vi.spyOn(browserZone, 'get').mockReturnValue('Europe/Moscow');
      await recreate();
      expect(el.querySelector('button.use-device-tz')).toBeNull();
    });

    it('no device-zone button when the device is already in the account zone', async () => {
      vi.spyOn(browserZone, 'get').mockReturnValue('Europe/Kyiv');
      await recreate();
      expect(el.querySelector('button.use-device-tz')).toBeNull();
    });
  });
});

describe('AccountSettings Discord identity', () => {
  let http: HttpTestingController;

  async function render(flag: boolean, identities: MeDto['identities']): Promise<HTMLElement> {
    await TestBed.configureTestingModule({
      imports: [AccountSettings],
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
    }).compileComponents();
    TestBed.inject(AuthStore).setMe({ ...me, identities });
    http = TestBed.inject(HttpTestingController);
    const store = TestBed.inject(PublicConfigStore);
    const loading = store.ensureLoaded();
    http.expectOne('/api/public-config').flush({
      telegramBotUsername: null,
      providers: { telegram: false, google: false, discord: flag },
    });
    await loading;
    const fixture = TestBed.createComponent(AccountSettings);
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/me/settings').flush({ calendarAutoBusy: true });
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => {
    http.verify();
  });

  it('shows an unavailable note with retry when the public config failed to load', async () => {
    await TestBed.configureTestingModule({
      imports: [AccountSettings],
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
    }).compileComponents();
    TestBed.inject(AuthStore).setMe({ ...me, identities: me.identities });
    http = TestBed.inject(HttpTestingController);
    const store = TestBed.inject(PublicConfigStore);
    const first = store.ensureLoaded();
    http.expectOne('/api/public-config').flush('x', { status: 500, statusText: 'x' });
    await first;
    const fixture = TestBed.createComponent(AccountSettings);
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/me/settings').flush({ calendarAutoBusy: true });
    fixture.detectChanges();
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('account.identities.configUnavailable');
    el.querySelector<HTMLButtonElement>('button.retry-config')!.click();
    http.expectOne('/api/public-config').flush({
      telegramBotUsername: null,
      providers: { telegram: false, google: false, discord: true },
    });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).not.toContain('account.identities.configUnavailable');
  });

  it('no «link Discord» button while the flag is off', async () => {
    const el = await render(false, me.identities);
    expect(el.querySelector('a.link-discord')).toBeNull();
  });

  it('with the flag on: a link button to the Discord OAuth start in link mode', async () => {
    const el = await render(true, me.identities);
    const link = el.querySelector<HTMLAnchorElement>('a.link-discord')!;
    expect(link.textContent).toContain('account.identities.linkDiscord');
    expect(link.getAttribute('href')).toBe('/api/auth/discord/start?mode=link&returnTo=%2Faccount');
  });

  it('a linked Discord is listed as an identity, without the link button', async () => {
    const el = await render(true, [...me.identities, { provider: 'discord', displayName: 'gm#1' }]);
    expect(el.querySelector('a.link-discord')).toBeNull();
    expect(el.querySelector('.identities')!.textContent).toContain('account.providers.discord');
    expect(el.querySelector('.identities')!.textContent).toContain('gm#1');
  });
});

describe('AccountSettings staff Telegram', () => {
  let http: HttpTestingController;

  async function render(role: MeDto['role']): Promise<HTMLElement> {
    await TestBed.configureTestingModule({
      imports: [AccountSettings],
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
    }).compileComponents();
    TestBed.inject(AuthStore).setMe({
      ...me,
      role,
      identities: [
        { provider: 'telegram', displayName: 'tg' },
        { provider: 'google', displayName: 'g' },
      ],
    });
    const fixture = TestBed.createComponent(AccountSettings);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/me/settings').flush({ calendarAutoBusy: true });
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  const unlinkButtons = (el: HTMLElement) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('.identities li button'));

  afterEach(() => http.verify());

  it('staff cannot unlink Telegram: the button is disabled and described by the explanation', async () => {
    const el = await render('moderator');
    const [telegram, google] = unlinkButtons(el);
    expect(telegram.disabled).toBe(true);
    expect(telegram.getAttribute('aria-describedby')).toBe('staff-telegram-hint');
    expect(el.querySelector('#staff-telegram-hint')!.textContent).toContain(
      'account.identities.staffHint',
    );
    // Other sign-in methods can still be unlinked by staff.
    expect(google.disabled).toBe(false);
  });

  it('a regular user can unlink Telegram, no explanation is shown', async () => {
    const el = await render('user');
    expect(unlinkButtons(el)[0].disabled).toBe(false);
    expect(el.querySelector('#staff-telegram-hint')).toBeNull();
  });
});
