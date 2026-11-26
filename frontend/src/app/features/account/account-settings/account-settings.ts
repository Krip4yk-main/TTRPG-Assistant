import {
  ChangeDetectionStrategy,
  Component,
  type WritableSignal,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatInputModule } from '@angular/material/input';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  DEFAULT_TIMEZONE,
  MIN_REGISTRATION_AGE,
  changeNicknameSchema,
  changeTimezoneSchema,
  isBlockedTimezone,
  normalizeTimezone,
  selectableTimezones,
  type ErrorCode,
  type IdentityProvider,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { isErrorCode, toApiError } from '../../../core/api/api-error';
import { AuthApi } from '../../../core/auth/auth.api';
import { AuthStore } from '../../../core/auth/auth.store';
import { CalendarApi } from '../../../core/calendar/calendar.api';
import {
  browserTimeZone,
  differentZones,
  fromIsoDate,
  provideUkDates,
  toIsoDate,
} from '../../../core/i18n/dates';
import { SocketService } from '../../../core/realtime/socket.service';
import {
  eagerErrorState,
  minAgeValidatorFor,
  nicknameValidator,
  timezoneValidator,
} from '../../../shared/forms/profile-validators';
import { UserName } from '../../../shared/user-name/user-name';
import { runtimeConfig } from '../../../../environments/runtime-config';
import { DeleteAccountDialog } from '../delete-account-dialog/delete-account-dialog';
import { ThemePicker } from '../theme-picker/theme-picker';

/** Коди, для яких є специфічні для профілю тексти (`profile.errors.*`). */
const PROFILE_ERROR_CODES = new Set<ErrorCode>([
  'AGE_TOO_LOW',
  'BIRTH_DATE_COOLDOWN',
  'NICKNAME_TAKEN',
]);

/** Найбільше варіантів поясу в списку автодоповнення. */
const MAX_TZ_OPTIONS = 50;

/** Пояси для вибору: з `Intl`, з правильними назвами (`Europe/Kyiv`) і без заблокованих. */
function supportedTimezones(): string[] {
  try {
    return selectableTimezones(Intl.supportedValuesOf('timeZone'));
  } catch {
    return [DEFAULT_TIMEZONE];
  }
}

/** Повідомлення секції: ключ i18n + параметри. */
interface Message {
  kind: 'error' | 'info';
  key: string;
  params?: Record<string, string | number>;
}

@Component({
  selector: 'nri-account-settings',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatDatepickerModule,
    MatFormFieldModule,
    MatIconModule,
    MatAutocompleteModule,
    MatInputModule,
    MatSlideToggleModule,
    MatTooltipModule,
    TranslatePipe,
    ThemePicker,
    UserName,
  ],
  providers: [provideUkDates()],
  templateUrl: './account-settings.html',
  styleUrl: './account-settings.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountSettings {
  private readonly api = inject(AuthApi);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly translate = inject(TranslateService);
  private readonly calendarApi = inject(CalendarApi);

  /** `?error=CODE` після невдалої прив'язки Google чи Discord. */
  readonly error = input<string>();

  protected readonly me = this.auth.me;
  protected readonly identities = computed(() => this.me()?.identities ?? []);
  protected readonly hasTelegram = computed(() => this.has('telegram'));
  protected readonly hasGoogle = computed(() => this.has('google'));
  protected readonly hasDiscord = computed(() => this.has('discord'));
  /** Відв'язати не можна останній спосіб входу (бекенд відповів би 409 LAST_IDENTITY). */
  protected readonly isLastIdentity = computed(() => this.identities().length <= 1);
  protected readonly canLinkTelegram = computed(
    () => !!runtimeConfig.telegramBotUsername && !this.hasTelegram(),
  );
  protected readonly canLinkGoogle = computed(() => runtimeConfig.googleLogin && !this.hasGoogle());
  protected readonly googleLinkUrl = this.api.googleStartUrl('link', '/account');
  protected readonly canLinkDiscord = computed(
    () => runtimeConfig.discordLogin && !this.hasDiscord(),
  );
  protected readonly discordLinkUrl = this.api.discordStartUrl('link', '/account');
  protected readonly birthDateIso = computed(() => this.me()?.birthDate ?? null);
  protected readonly minAge = MIN_REGISTRATION_AGE;
  protected readonly maxBirthDate = new Date();
  protected readonly errorState = eagerErrorState;

  protected readonly busy = signal(false);
  protected readonly identityMessage = signal<Message | null>(null);
  protected readonly telegramPending = signal(false);
  protected readonly nicknameError = signal<string | null>(null);
  protected readonly nicknameSaved = signal(false);
  protected readonly birthDateMessage = signal<Message | null>(null);
  protected readonly birthDateSaved = signal(false);
  protected readonly dangerMessage = signal<Message | null>(null);
  protected readonly timezoneMessage = signal<Message | null>(null);
  protected readonly timezoneSaved = signal(false);
  /** Сесії ігор автоматично займають календар; `null` — налаштування ще не завантажено. */
  protected readonly autoBusy = signal<boolean | null>(null);
  protected readonly autoBusyBusy = signal(false);
  protected readonly autoBusyMessage = signal<Message | null>(null);
  protected readonly queryErrorKey = computed(() => {
    const code = this.error();
    if (!code) return null;
    return isErrorCode(code) ? `errors.${code}` : 'errors.UNKNOWN';
  });

  protected readonly nickname = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, nicknameValidator],
  });

  protected readonly nicknameForm = new FormGroup({ nickname: this.nickname });

  protected readonly birthDate = new FormControl<Date | null>(null, [
    Validators.required,
    minAgeValidatorFor(() => this.me()?.timezone),
  ]);

  protected readonly birthDateForm = new FormGroup({ birthDate: this.birthDate });

  protected readonly timezone = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, timezoneValidator],
  });

  protected readonly timezoneForm = new FormGroup({ timezone: this.timezone });

  private readonly allTimezones = supportedTimezones();
  private readonly timezoneQuery = signal('');
  /** Пошук поясу: збіг за підрядком (без регістру), не більше `MAX_TZ_OPTIONS`. */
  protected readonly timezoneOptions = computed(() => {
    const q = this.timezoneQuery().trim().toLowerCase().replace(/\s+/g, '_');
    const list = q
      ? this.allTimezones.filter((tz) => tz.toLowerCase().includes(q))
      : this.allTimezones;
    return list.slice(0, MAX_TZ_OPTIONS);
  });
  // Пояс пристрою як підказка — з правильною назвою; заблокований не пропонуємо.
  private readonly deviceTz = isBlockedTimezone(browserTimeZone())
    ? null
    : normalizeTimezone(browserTimeZone());
  /** Пояс пристрою, якщо він відрізняється від введеного; інакше `null`. */
  protected readonly deviceZone = computed(() =>
    this.deviceTz && differentZones(this.deviceTz, this.timezoneQuery()) ? this.deviceTz : null,
  );

  constructor() {
    void this.loadCalendarSettings();
    this.nickname.setValue(this.me()?.nickname ?? '');
    const current = this.me()?.birthDate;
    if (current) this.birthDate.setValue(fromIsoDate(current));
    this.timezone.setValue(this.me()?.timezone ?? '');
    this.timezoneQuery.set(this.timezone.value);
    this.timezone.valueChanges.pipe(takeUntilDestroyed()).subscribe((v) => {
      this.timezoneQuery.set(v);
      this.timezoneSaved.set(false);
    });

    // Бот підтвердив прив'язку Telegram → оновлюємо профіль.
    inject(SocketService)
      .on<{ provider: IdentityProvider }>('identity.linked')
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        this.telegramPending.set(false);
        this.identityMessage.set({ kind: 'info', key: 'account.identities.linked' });
        void this.auth.load();
      });
  }

  protected providerKey(provider: IdentityProvider): string {
    return `account.providers.${provider}`;
  }

  protected async unlink(provider: IdentityProvider): Promise<void> {
    await this.run(this.identityMessage, async () => {
      const { identities } = await firstValueFrom(this.api.unlinkIdentity(provider));
      const me = this.me();
      if (me) this.auth.setMe({ ...me, identities });
      this.identityMessage.set({ kind: 'info', key: 'account.identities.unlinked' });
    });
  }

  protected async linkTelegram(): Promise<void> {
    // Вкладку відкриваємо синхронно в обробнику кліку, інакше її заблокує браузер.
    const tab = window.open('', '_blank');
    await this.run(this.identityMessage, async () => {
      try {
        const { url } = await firstValueFrom(this.api.telegramLinkToken());
        if (tab) {
          tab.opener = null;
          tab.location.href = url;
        } else {
          window.open(url, '_blank', 'noopener');
        }
        this.telegramPending.set(true);
      } catch (err) {
        tab?.close();
        throw err;
      }
    });
  }

  protected async saveNickname(): Promise<void> {
    if (this.busy()) return;
    const parsed = changeNicknameSchema.safeParse({ nickname: this.nickname.value.trim() });
    if (this.nickname.invalid || !parsed.success) {
      this.nickname.markAsTouched();
      return;
    }
    this.nicknameSaved.set(false);
    this.nicknameError.set(null);
    this.busy.set(true);
    try {
      const me = await firstValueFrom(this.api.changeNickname(parsed.data.nickname));
      this.auth.setMe(me);
      this.nickname.setValue(me.nickname ?? '');
      this.nicknameSaved.set(true);
    } catch (err) {
      const { code } = toApiError(err);
      if (code === 'NICKNAME_TAKEN') {
        this.nickname.setErrors({ ...this.nickname.errors, taken: true });
        this.nickname.markAsTouched();
      } else if (code !== 'UNAUTHENTICATED') {
        this.nicknameError.set(`errors.${code}`);
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected async saveBirthDate(): Promise<void> {
    const value = this.birthDate.value;
    if (this.birthDate.invalid || !value) {
      this.birthDate.markAsTouched();
      return;
    }
    this.birthDateSaved.set(false);
    await this.run(this.birthDateMessage, async () => {
      const me = await firstValueFrom(this.api.changeBirthDate(toIsoDate(value)));
      this.auth.setMe(me);
      this.birthDateSaved.set(true);
    });
  }

  protected useDeviceZone(): void {
    const device = this.deviceZone();
    if (!device) return;
    this.timezone.setValue(device);
    this.timezone.markAsDirty();
  }

  protected async saveTimezone(): Promise<void> {
    const parsed = changeTimezoneSchema.safeParse({ timezone: this.timezone.value.trim() });
    if (this.timezone.invalid || !parsed.success) {
      this.timezone.markAsTouched();
      return;
    }
    this.timezoneSaved.set(false);
    await this.run(this.timezoneMessage, async () => {
      const me = await firstValueFrom(this.api.changeTimezone(parsed.data.timezone));
      this.auth.setMe(me);
      this.timezone.setValue(me.timezone);
      this.timezoneSaved.set(true);
    });
  }

  /** Перемикач автозайнятості: оптимістично, з поверненням стану при помилці. */
  protected async setAutoBusy(value: boolean): Promise<void> {
    if (this.autoBusyBusy()) return;
    this.autoBusyBusy.set(true);
    this.autoBusyMessage.set(null);
    this.autoBusy.set(value);
    try {
      const saved = await firstValueFrom(
        this.calendarApi.updateSettings({ calendarAutoBusy: value }),
      );
      this.autoBusy.set(saved.calendarAutoBusy);
      this.autoBusyMessage.set({ kind: 'info', key: 'account.calendar.saved' });
    } catch (err) {
      this.autoBusy.set(!value);
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') {
        this.autoBusyMessage.set({ kind: 'error', key: `errors.${code}` });
      }
    } finally {
      this.autoBusyBusy.set(false);
    }
  }

  private async loadCalendarSettings(): Promise<void> {
    try {
      const { calendarAutoBusy } = await firstValueFrom(this.calendarApi.settings());
      this.autoBusy.set(calendarAutoBusy);
    } catch (err) {
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') {
        this.autoBusyMessage.set({ kind: 'error', key: 'account.calendar.loadError' });
      }
    }
  }

  protected async logoutAll(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      // Навіть якщо запит упав, локальний стан уже очищено (AuthStore.logoutAll) —
      // користувач у будь-якому разі опиняється на сторінці входу.
      await this.auth.logoutAll();
    } catch {
      // ігноруємо: див. вище
    } finally {
      this.busy.set(false);
      await this.router.navigateByUrl('/login');
    }
  }

  protected async deleteAccount(): Promise<void> {
    const ref = this.dialog.open<DeleteAccountDialog, void, boolean>(DeleteAccountDialog, {
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    const confirmed = await firstValueFrom(ref.afterClosed());
    if (!confirmed) return;
    await this.run(this.dangerMessage, async () => {
      await firstValueFrom(this.api.deleteAccount());
      this.auth.setMe(null);
      await this.router.navigateByUrl('/login');
    });
  }

  private has(provider: IdentityProvider): boolean {
    return this.identities().some((i) => i.provider === provider);
  }

  /** Виконує дію, показуючи перекладену помилку API в потрібній секції. */
  private async run(
    target: WritableSignal<Message | null>,
    action: () => Promise<void>,
  ): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    target.set(null);
    try {
      await action();
    } catch (err) {
      const { code, details } = toApiError(err);
      // 401 уже обробив authInterceptor (очистив стан і перейшов на /login).
      if (code === 'UNAUTHENTICATED') return;
      const scope = PROFILE_ERROR_CODES.has(code) ? 'profile.errors.' : 'errors.';
      target.set({ kind: 'error', key: `${scope}${code}`, params: this.errorParams(details) });
    } finally {
      this.busy.set(false);
    }
  }

  private errorParams(details: unknown): Record<string, string | number> {
    const params: Record<string, string | number> = { age: MIN_REGISTRATION_AGE };
    const availableAt = (details as { availableAt?: unknown } | undefined)?.availableAt;
    if (typeof availableAt === 'string') {
      params['date'] = new Date(availableAt).toLocaleDateString(
        this.translate.getCurrentLang() === 'uk' ? 'uk-UA' : undefined,
        { day: 'numeric', month: 'long', year: 'numeric' },
      );
    }
    return params;
  }
}
