import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  type OnInit,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
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
import { runtimeConfig } from '../../../../environments/runtime-config';
import { isErrorCode, toApiError } from '../../../core/api/api-error';
import { safeReturnTo } from '../../../core/api/auth.interceptor';
import { AuthApi, type TelegramAuthData } from '../../../core/auth/auth.api';
import { AuthStore } from '../../../core/auth/auth.store';
import { BannedNotice } from '../banned-notice/banned-notice';

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

  /** `?error=CODE` після OAuth-редиректу або відхиленої реєстрації. */
  readonly error = input<string>();
  /** `?returnTo=/path` — куди повернутися після входу (лише внутрішні шляхи). */
  readonly returnTo = input<string>();
  /** `?appeal=TOKEN` разом з `error=ACCOUNT_BANNED` після OAuth-входу заблокованого. */
  readonly appeal = input<string>();

  /** Акаунт заблоковано: показуємо екран апеляції замість способів входу. */
  protected readonly banned = signal<BannedLoginDetails | null>(null);

  protected readonly telegramBot = runtimeConfig.telegramBotUsername;
  protected readonly devLoginEnabled = runtimeConfig.devLogin;
  protected readonly googleLogin = runtimeConfig.googleLogin;
  private readonly target = computed(() => safeReturnTo(this.returnTo()) ?? '/');
  protected readonly googleUrl = computed(() => this.api.googleStartUrl('login', this.target()));

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

  constructor() {
    const win = window as TelegramWindow;
    inject(DestroyRef).onDestroy(() => delete win[TELEGRAM_CALLBACK]);
    afterNextRender(() => {
      const host = this.telegramContainer()?.nativeElement;
      if (!this.telegramBot || !host) return;
      win[TELEGRAM_CALLBACK] = (user) => void this.onTelegramAuth(user);
      const script = document.createElement('script');
      script.async = true;
      script.src = TELEGRAM_WIDGET_SRC;
      script.dataset['telegramLogin'] = this.telegramBot;
      script.dataset['size'] = 'large';
      script.dataset['radius'] = '8';
      script.dataset['lang'] = 'uk';
      script.dataset['requestAccess'] = 'write';
      script.dataset['onauth'] = `${TELEGRAM_CALLBACK}(user)`;
      host.appendChild(script);
    });
  }

  ngOnInit(): void {
    const token = this.appeal();
    if (this.error() === 'ACCOUNT_BANNED' && token) {
      this.banned.set({ appealToken: token, appealSent: false });
    }
    // Токен не лишаємо ні в адресі, ні в історії (заміна поточного запису).
    if (token !== undefined) {
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { error: null, appeal: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    }
  }

  /** З екрана бану — назад до способів входу (отримати новий токен). */
  protected leaveBanned(): void {
    this.banned.set(null);
    this.actionError.set(null);
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
      if (code === 'ACCOUNT_BANNED' && isBannedDetails(details)) {
        this.banned.set({ appealToken: details.appealToken, appealSent: details.appealSent });
      } else {
        this.actionError.set(code);
      }
    } finally {
      this.busy.set(false);
    }
  }
}

function isBannedDetails(d: unknown): d is BannedLoginDetails {
  const v = d as Partial<BannedLoginDetails> | null | undefined;
  return (
    typeof v?.appealToken === 'string' && v.appealToken !== '' && typeof v.appealSent === 'boolean'
  );
}
