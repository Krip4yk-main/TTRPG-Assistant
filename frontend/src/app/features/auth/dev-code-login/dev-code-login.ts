import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import type { BannedLoginDetails, ErrorCode } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { safeReturnTo } from '../../../core/api/auth.interceptor';
import { AuthApi } from '../../../core/auth/auth.api';
import { AuthStore } from '../../../core/auth/auth.store';
import { bannedDetails } from '../../../core/auth/banned';
import { nicknameValidator } from '../../../shared/forms/profile-validators';
import { BannedNotice } from '../banned-notice/banned-notice';

/** Коди помилок, для яких на цій сторінці є власний, не загальний текст. */
const OWN_ERRORS: readonly ErrorCode[] = [
  'FORBIDDEN',
  'RATE_LIMITED',
  'NICKNAME_TAKEN',
  'VALIDATION',
];

/**
 * Dev-вхід на беті: код доступу тестера + нік. Сторінка відкривається лише за прямим посиланням.
 * Невірний код і заборона для персоналу показуються однією нейтральною помилкою (без підказок).
 */
@Component({
  selector: 'nri-dev-code-login',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
    BannedNotice,
  ],
  templateUrl: './dev-code-login.html',
  styleUrl: '../login/login.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DevCodeLogin {
  private readonly api = inject(AuthApi);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  /** `?returnTo=/path` — куди повернутися після входу (лише внутрішні шляхи). */
  readonly returnTo = input<string>();

  protected readonly banned = signal<BannedLoginDetails | null>(null);
  protected readonly busy = signal(false);
  private readonly actionError = signal<ErrorCode | null>(null);
  protected readonly errorKey = computed(() => {
    const code = this.actionError();
    if (!code) return null;
    return OWN_ERRORS.includes(code) ? `login.devCode.errors.${code}` : `errors.${code}`;
  });

  protected readonly form = new FormGroup({
    code: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    nickname: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, nicknameValidator],
    }),
  });

  protected async submit(): Promise<void> {
    if (this.busy()) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const { code, nickname } = this.form.getRawValue();
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const { user } = await firstValueFrom(
        this.api.devCodeLogin({ code, nickname: nickname.trim() }),
      );
      this.auth.setMe(user);
      await this.router.navigateByUrl(
        user.status === 'pending' ? '/complete-profile' : (safeReturnTo(this.returnTo()) ?? '/'),
      );
    } catch (err) {
      const { code: errCode, details } = toApiError(err);
      const ban = errCode === 'ACCOUNT_BANNED' ? bannedDetails(details) : null;
      if (ban) this.banned.set(ban);
      else this.actionError.set(errCode);
    } finally {
      this.busy.set(false);
    }
  }

  protected leaveBanned(): void {
    this.banned.set(null);
    this.actionError.set(null);
  }
}
