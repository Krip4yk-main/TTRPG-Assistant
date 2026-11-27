import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import { APPLICATION_CONSTRAINT_MAX, APPLICATION_CONSTRAINTS_MAX } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '../../../core/auth/auth.api';
import { AuthStore } from '../../../core/auth/auth.store';

/** Рядки поля → унікальні непорожні межі (по одній на рядок). */
export function parseLimits(text: string): string[] {
  return [
    ...new Set(
      text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Згорнутий блок «Мої межі (бачите лише ви)» у профілі: приватні нотатки, які можна
 * одним кліком підставити в заявку. Розгорнутий лише якщо вже має вміст. Ніде не показується іншим.
 */
@Component({
  selector: 'nri-my-limits',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
  ],
  templateUrl: './my-limits.html',
  styleUrl: './my-limits.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MyLimits {
  private readonly api = inject(AuthApi);
  private readonly auth = inject(AuthStore);

  protected readonly max = APPLICATION_CONSTRAINTS_MAX;
  protected readonly maxLen = APPLICATION_CONSTRAINT_MAX;
  private readonly initial = this.auth.me()?.myLimits ?? [];
  protected readonly open = this.initial.length > 0;
  protected readonly control = new FormControl(this.initial.join('\n'), { nonNullable: true });
  protected readonly saving = signal(false);
  protected readonly status = signal<'saved' | 'error' | 'invalid' | null>(null);

  protected async save(): Promise<void> {
    if (this.saving()) return;
    const limits = parseLimits(this.control.value);
    if (limits.length > this.max || limits.some((l) => l.length > this.maxLen)) {
      this.status.set('invalid');
      return;
    }
    this.saving.set(true);
    this.status.set(null);
    try {
      const me = await firstValueFrom(this.api.changeMyLimits(limits));
      this.auth.setMe(me);
      this.control.setValue(me.myLimits.join('\n'));
      this.status.set('saved');
    } catch {
      this.status.set('error');
    } finally {
      this.saving.set(false);
    }
  }
}
