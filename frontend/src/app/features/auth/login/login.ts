import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  Injector,
  type OnInit,
  afterNextRender,
  computed,
  effect,
  InjectionToken,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import type { BannedLoginDetails, ErrorCode, MeDto } from '@nri/shared';
import { firstValueFrom, type Observable } from 'rxjs';
import { devLoginMode, type DevLoginMode } from '../../../../environments/runtime-config';
import { isErrorCode, toApiError } from '../../../core/api/api-error';
import { safeReturnTo } from '../../../core/api/auth.interceptor';
import { AuthApi, type TelegramAuthData } from '../../../core/auth/auth.api';
import { AuthStore } from '../../../core/auth/auth.store';
import { appealStatusOf, bannedDetails } from '../../../core/auth/banned';
import { PublicConfigStore } from '../../../core/config/public-config.store';
import { BannedNotice } from '../banned-notice/banned-notice';

/** Режим dev-входу (build-time). Токен, а не інпут: роутер скидає непов'язані інпути в undefined. */
export const DEV_LOGIN_MODE = new InjectionToken<DevLoginMode>('DEV_LOGIN_MODE', {
  factory: () => devLoginMode,
});

const TELEGRAM_WIDGET_SRC = 'https://telegram.org/js/telegram-widget.js?22';
/** Глобальна функція, яку викликає віджет Telegram (`data-onauth`). */
const TELEGRAM_CALLBACK = 'nriTelegramAuth';

type TelegramWindow = Window & { [TELEGRAM_CALLBACK]?: (user: TelegramAuthData) => void };

@Component({
  selector: 'nri-login',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
    BannedNotice,
  ],
  templateUrl: './login.html',
  styleUrl: './login.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Login implements OnInit {
  private readonly api = inject(AuthApi);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly injector = inject(Injector);
  private readonly publicConfig = inject(PublicConfigStore);

  /** `?error=CODE` після OAuth-редиректу або відхиленої реєстрації. */
  readonly error = input<string>();
  /** `?returnTo=/path` — куди повернутися після входу (лише внутрішні шляхи). */
  readonly returnTo = input<string>();
  /** `?appeal=TOKEN` разом з `error=ACCOUNT_BANNED` після OAuth-входу заблокованого. */
  readonly appeal = input<string>();
  /** `?sent=1` — апеляцію в цьому періоді бану вже надіслано. */
  readonly sent = input<string>();
  /** `?appealStatus=pending|accepted|rejected` — стан уже поданої апеляції. */
  readonly appealStatus = input<string>();

  /** Акаунт заблоковано: показуємо екран апеляції замість способів входу. */
  protected readonly banned = signal<BannedLoginDetails | null>(null);

  /** Ім'я Telegram-бота й увімкнені провайдери — з бекенду (`/api/public-config`). */
  protected readonly telegramBot = this.publicConfig.telegramBotUsername;
  /** Форма dev-входу на /login — лише в режимі `local`. */
  private readonly devLoginMode = inject(DEV_LOGIN_MODE);
  protected readonly devLoginEnabled = computed(() => this.devLoginMode === 'local');
  protected readonly googleLogin = this.publicConfig.googleLogin;
  protected readonly discordLogin = this.publicConfig.discordLogin;
  private readonly target = computed(() => safeReturnTo(this.returnTo()) ?? '/');
  protected readonly googleUrl = computed(() => this.api.googleStartUrl('login', this.target()));
  protected readonly discordUrl = computed(() => this.api.discordStartUrl('login', this.target()));

  /** Конфіг не завантажився (бекенд недоступний): замість «немає способів входу» — повтор. */
  protected readonly configFailed = this.publicConfig.failed;
  protected readonly retrying = signal(false);

  protected readonly busy = signal(false);
  private readonly actionError = signal<ErrorCode | null>(null);
  protected readonly errorKey = computed(() => {
    const code = this.actionError() ?? this.error();
    if (!code) return null;
    return isErrorCode(code) ? `errors.${code}` : 'errors.UNKNOWN';
  });

  protected readonly devForm = new FormGroup({
    nickname: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    ownerKey: new FormControl('', { nonNullable: true }),
  });

  private readonly telegramContainer = viewChild<ElementRef<HTMLElement>>('telegramWidget');
  private readonly loginTitle = viewChild<ElementRef<HTMLElement>>('loginTitle');

  constructor() {
    // Бан посеред сесії: деталі апеляції в пам'яті AuthStore (не в адресі).
    effect(() => {
      const pending = this.auth.pendingBan();
      if (!pending) return;
      untracked(() => {
        this.auth.clearPendingBan();
        this.banned.set(pending);
        if (this.error() === 'ACCOUNT_BANNED') this.cleanQuery();
      });
    });
    const win = window as TelegramWindow;
    inject(DestroyRef).onDestroy(() => delete win[TELEGRAM_CALLBACK]);
    afterNextRender(() => this.mountTelegramWidget());
  }

  protected async retryConfig(): Promise<void> {
    if (this.retrying()) return;
    this.retrying.set(true);
    try {
      await this.publicConfig.ensureLoaded();
    } finally {
      this.retrying.set(false);
    }
    // Контейнер віджета з'явиться після наступного рендера.
    afterNextRender(() => this.mountTelegramWidget(), { injector: this.injector });
  }

  private mountTelegramWidget(): void {
    const win = window as TelegramWindow;
    const host = this.telegramContainer()?.nativeElement;
    const bot = this.telegramBot();
    if (!bot || !host || host.childElementCount > 0) return;
    win[TELEGRAM_CALLBACK] = (user) => void this.onTelegramAuth(user);
    const script = document.createElement('script');
    script.async = true;
    script.src = TELEGRAM_WIDGET_SRC;
    script.dataset['telegramLogin'] = bot;
    script.dataset['size'] = 'large';
    script.dataset['radius'] = '8';
    script.dataset['lang'] = 'uk';
    script.dataset['requestAccess'] = 'write';
    script.dataset['onauth'] = `${TELEGRAM_CALLBACK}(user)`;
    host.appendChild(script);
  }

  ngOnInit(): void {
    const token = this.appeal();
    if (this.error() === 'ACCOUNT_BANNED' && token) {
      this.banned.set({
        appealToken: token,
        appealSent: this.sent() === '1',
        appealStatus: appealStatusOf(this.appealStatus()),
      });
    }
    // Токен не лишаємо ні в адресі, ні в історії (заміна поточного запису).
    if (token !== undefined || this.sent() !== undefined || this.appealStatus() !== undefined) {
      this.cleanQuery();
    }
  }

  /** З екрана бану — назад до способів входу (отримати новий токен); фокус — на заголовок. */
  protected leaveBanned(): void {
    this.banned.set(null);
    this.actionError.set(null);
    afterNextRender(() => this.loginTitle()?.nativeElement.focus(), { injector: this.injector });
  }

  private cleanQuery(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { error: null, appeal: null, sent: null, appealStatus: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected async devLogin(): Promise<void> {
    if (this.devForm.invalid) {
      this.devForm.markAllAsTouched();
      return;
    }
    const { nickname, ownerKey } = this.devForm.getRawValue();
    await this.signIn(
      this.api.devLogin({ nickname: nickname.trim(), ...(ownerKey ? { ownerKey } : {}) }),
    );
  }

  private async onTelegramAuth(user: TelegramAuthData): Promise<void> {
    await this.signIn(this.api.telegramLogin(user));
  }

  private async signIn(request: Observable<{ user: MeDto }>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const { user } = await firstValueFrom(request);
      this.auth.setMe(user);
      await this.router.navigateByUrl(
        user.status === 'pending' ? '/complete-profile' : this.target(),
      );
    } catch (err) {
      const { code, details } = toApiError(err);
      const ban = code === 'ACCOUNT_BANNED' ? bannedDetails(details) : null;
      if (ban) {
        this.banned.set(ban);
      } else {
        this.actionError.set(code);
      }
    } finally {
      this.busy.set(false);
    }
  }
}
