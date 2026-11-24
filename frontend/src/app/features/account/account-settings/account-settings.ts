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
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  MIN_REGISTRATION_AGE,
  changeNicknameSchema,
  type ErrorCode,
  type IdentityProvider,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { isErrorCode, toApiError } from '../../../core/api/api-error';
import { AuthApi } from '../../../core/auth/auth.api';
import { AuthStore } from '../../../core/auth/auth.store';
import { fromIsoDate, provideUkDates, toIsoDate } from '../../../core/i18n/dates';
import { SocketService } from '../../../core/realtime/socket.service';
import {
  eagerErrorState,
  minAgeValidatorFor,
  nicknameValidator,
} from '../../../shared/forms/profile-validators';
import { UserName } from '../../../shared/user-name/user-name';
import { runtimeConfig } from '../../../../environments/runtime-config';
import { DeleteAccountDialog } from '../delete-account-dialog/delete-account-dialog';

/** Коди, для яких є специфічні для профілю тексти (`profile.errors.*`). */
const PROFILE_ERROR_CODES = new Set<ErrorCode>([
  'AGE_TOO_LOW',
  'BIRTH_DATE_COOLDOWN',
  'NICKNAME_TAKEN',
]);

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
    MatInputModule,
    MatTooltipModule,
    TranslatePipe,
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

  /** `?error=CODE` після невдалої прив'язки Google. */
  readonly error = input<string>();

  protected readonly me = this.auth.me;
  protected readonly identities = computed(() => this.me()?.identities ?? []);
  protected readonly hasTelegram = computed(() => this.has('telegram'));
  protected readonly hasGoogle = computed(() => this.has('google'));
  /** Відв'язати не можна останній спосіб входу (бекенд відповів би 409 LAST_IDENTITY). */
  protected readonly isLastIdentity = computed(() => this.identities().length <= 1);
  protected readonly canLinkTelegram = computed(
    () => !!runtimeConfig.telegramBotUsername && !this.hasTelegram(),
  );
  protected readonly canLinkGoogle = computed(() => runtimeConfig.googleLogin && !this.hasGoogle());
  protected readonly googleLinkUrl = this.api.googleStartUrl('link', '/account');
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

  constructor() {
    this.nickname.setValue(this.me()?.nickname ?? '');
    const current = this.me()?.birthDate;
    if (current) this.birthDate.setValue(fromIsoDate(current));

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
