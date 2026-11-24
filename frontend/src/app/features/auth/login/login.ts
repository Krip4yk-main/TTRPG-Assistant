import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import { type ErrorCode } from '@nri/shared';
import { firstValueFrom, type Observable } from 'rxjs';
import { runtimeConfig } from '../../../../environments/runtime-config';
import { isErrorCode, toApiError } from '../../../core/api/api-error';
import { AuthApi, type TelegramAuthData } from '../../../core/auth/auth.api';
import { AuthStore } from '../../../core/auth/auth.store';
import type { MeDto } from '../../../core/auth/me.model';

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
  ],
  templateUrl: './login.html',
  styleUrl: './login.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Login {
  private readonly api = inject(AuthApi);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  /** `?error=CODE` після OAuth-редиректу або відхиленої реєстрації. */
  readonly error = input<string>();

  protected readonly telegramBot = runtimeConfig.telegramBotUsername;
  protected readonly devLoginEnabled = runtimeConfig.devLogin;
  protected readonly googleUrl = this.api.googleStartUrl('login', '/');

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
      await this.router.navigateByUrl(user.status === 'pending' ? '/complete-profile' : '/');
    } catch (err) {
      this.actionError.set(toApiError(err).code);
    } finally {
      this.busy.set(false);
    }
  }
}
