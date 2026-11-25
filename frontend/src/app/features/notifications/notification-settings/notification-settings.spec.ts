import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import {
  NOTIFICATION_CATEGORIES,
  defaultNotificationPrefs,
  type MeDto,
  type NotificationPrefsDto,
} from '@nri/shared';
import uk from '../../../../assets/i18n/uk.json';
import { routes } from '../../../app.routes';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';
import { NotificationSettings } from './notification-settings';

const me = (telegram: boolean): MeDto => ({
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
  uiPrefs: { tearAnimation: true },
  identities: telegram
    ? [{ provider: 'telegram', displayName: '@gandalf' }]
    : [{ provider: 'dev', displayName: 'G' }],
});

const flushAsync = () => new Promise((r) => setTimeout(r, 0));

describe('NotificationSettings', () => {
  let fixture: ComponentFixture<NotificationSettings>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let snack: { open: ReturnType<typeof vi.fn> };

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  const toggleInput = (category: string) =>
    el.querySelector<HTMLButtonElement>(`mat-slide-toggle[data-category="${category}"] button`)!;
  const chip = (offset: number) =>
    el.querySelector<HTMLElement>(`mat-chip-option[data-offset="${offset}"]`)!;
  const chipSelected = (offset: number) =>
    chip(offset).querySelector('[role="option"]')!.getAttribute('aria-selected') === 'true';
  const clickChip = async (offset: number) => {
    chip(offset).querySelector<HTMLElement>('.mdc-evolution-chip__action--primary')!.click();
    await settle();
  };

  const start = async (
    telegram: boolean,
    prefs: NotificationPrefsDto = defaultNotificationPrefs(),
  ) => {
    TestBed.inject(AuthStore).setMe(me(telegram));
    fixture = TestBed.createComponent(NotificationSettings);
    el = fixture.nativeElement as HTMLElement;
    await settle();
    http.expectOne('/api/me/notification-prefs').flush(prefs);
    await flushAsync();
    await settle();
  };

  beforeEach(async () => {
    snack = { open: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [NotificationSettings],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService({ fallbackLang: 'uk', lang: 'uk' }),
        { provide: MatSnackBar, useValue: snack },
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
    TestBed.inject(TranslateService).setTranslation('uk', uk);
    TestBed.inject(TranslateService).use('uk');
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('loads prefs: a toggle per category and default offsets selected', async () => {
    await start(true, {
      ...defaultNotificationPrefs(),
      telegram: { ...defaultNotificationPrefs().telegram, games: false },
    });
    for (const c of NOTIFICATION_CATEGORIES) {
      expect(toggleInput(c)).not.toBeNull();
      expect(toggleInput(c).disabled).toBe(false);
      expect(el.textContent).toContain(uk.notifications.categories[c].label);
    }
    expect(toggleInput('games').getAttribute('aria-checked')).toBe('false');
    expect(toggleInput('sessions').getAttribute('aria-checked')).toBe('true');
    expect(chipSelected(1440)).toBe(true);
    expect(chipSelected(60)).toBe(true);
    expect(chipSelected(15)).toBe(false);
    expect(el.querySelector('.telegram-callout')).toBeNull();
    expect(el.textContent).toContain(uk.notifications.settings.reminders.offsets['2880']);
  });

  it('toggle + offsets → PUT payload (sorted descending), snackbar on success', async () => {
    await start(true);
    toggleInput('applications').click();
    await settle();
    await clickChip(15);
    await clickChip(1440);
    el.querySelector<HTMLButtonElement>('button.save')!.click();
    await settle();
    const req = http.expectOne('/api/me/notification-prefs');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({
      telegram: { ...defaultNotificationPrefs().telegram, applications: false },
      reminderOffsets: [60, 15],
    });
    req.flush({ ...req.request.body });
    await flushAsync();
    await settle();
    expect(snack.open).toHaveBeenCalledWith(uk.notifications.settings.saved, '', expect.anything());
  });

  it('no offsets = reminders off (explained), saved as []', async () => {
    await start(true);
    expect(el.querySelector('.reminders-off')).toBeNull();
    await clickChip(1440);
    await clickChip(60);
    expect(el.querySelector('.reminders-off')!.textContent).toContain(
      uk.notifications.settings.reminders.none,
    );
    el.querySelector<HTMLButtonElement>('button.save')!.click();
    const req = http.expectOne('/api/me/notification-prefs');
    expect(req.request.body.reminderOffsets).toEqual([]);
    req.flush({ ...req.request.body });
    await flushAsync();
  });

  it('no Telegram linked: callout with a link to /account, toggles visible but disabled', async () => {
    await start(false);
    const callout = el.querySelector('.telegram-callout')!;
    expect(callout.textContent).toContain(uk.notifications.settings.telegram.notLinked);
    expect(callout.querySelector('a[href="/account"]')).not.toBeNull();
    for (const c of NOTIFICATION_CATEGORIES) expect(toggleInput(c).disabled).toBe(true);
  });

  it('Save is disabled while the form is pristine (and again after toggling back)', async () => {
    await start(true);
    const save = () => el.querySelector<HTMLButtonElement>('button.save')!;
    expect(save().disabled).toBe(true);
    toggleInput('games').click();
    await settle();
    expect(save().disabled).toBe(false);
    toggleInput('games').click();
    await settle();
    expect(save().disabled).toBe(true);
    await clickChip(15);
    expect(save().disabled).toBe(false);
  });

  it('save error shows the translated error code', async () => {
    await start(true);
    await clickChip(15);
    el.querySelector<HTMLButtonElement>('button.save')!.click();
    http
      .expectOne('/api/me/notification-prefs')
      .flush({ error: { code: 'VALIDATION' } }, { status: 400, statusText: 'Bad Request' });
    await flushAsync();
    await settle();
    expect(el.querySelector('.save-error')!.textContent).toContain(uk.errors.VALIDATION);
    expect(snack.open).not.toHaveBeenCalled();
  });

  it('load error offers a retry', async () => {
    TestBed.inject(AuthStore).setMe(me(true));
    fixture = TestBed.createComponent(NotificationSettings);
    el = fixture.nativeElement as HTMLElement;
    await settle();
    http.expectOne('/api/me/notification-prefs').flush(null, { status: 500, statusText: 'err' });
    await flushAsync();
    await settle();
    expect(el.textContent).toContain(uk.notifications.settings.loadError);
    el.querySelector<HTMLButtonElement>('.load-error button')!.click();
    http.expectOne('/api/me/notification-prefs').flush(defaultNotificationPrefs());
    await flushAsync();
    await settle();
    expect(toggleInput('games')).not.toBeNull();
  });

  it('route /settings/notifications is guarded like other auth pages', () => {
    const route = routes.find((r) => r.path === 'settings/notifications')!;
    expect(route.canActivate?.length).toBe(1);
    expect(route.title).toBe('titles.notificationSettings');
    expect(uk.titles.notificationSettings).toBeTruthy();
  });
});
