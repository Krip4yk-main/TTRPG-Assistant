import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import { IMAGE_URL_INVALID_REASONS, updateAvatarSchema, type AvatarSource } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthApi } from '../../../core/auth/auth.api';
import { AuthStore } from '../../../core/auth/auth.store';

interface Choice {
  source: AvatarSource;
  /** Картинка для прев'ю; `null` — показуємо заглушку. */
  preview: string | null;
  icon: string;
}

/**
 * Блок «Аватар» у профілі: джерело (Google / Discord / Telegram — лише прив'язані й з фото),
 * «Автоматично», власне посилання або без аватара. Після збереження оновлює `AuthStore`.
 */
@Component({
  selector: 'nri-avatar-picker',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    TranslatePipe,
  ],
  templateUrl: './avatar-picker.html',
  styleUrl: './avatar-picker.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AvatarPicker {
  private readonly api = inject(AuthApi);
  private readonly auth = inject(AuthStore);

  protected readonly customUrl = new FormControl(this.auth.me()?.customAvatarUrl ?? '', {
    nonNullable: true,
  });
  protected readonly selected = signal<AvatarSource>(this.auth.me()?.avatarSource ?? 'auto');
  protected readonly saving = signal(false);
  /** Ключ i18n помилки біля поля посилання (з причиною). */
  protected readonly urlError = signal<string | null>(null);
  /** Загальна помилка збереження або підтвердження. */
  protected readonly message = signal<{ kind: 'error' | 'info'; key: string } | null>(null);
  /** Посилання, що не завантажилось у браузері: замість нього — заглушка. */
  protected readonly broken = signal<ReadonlySet<string>>(new Set());

  protected readonly choices = computed<Choice[]>(() => {
    const me = this.auth.me();
    const providers: Choice[] = (me?.avatarOptions ?? []).map((o) => ({
      source: o.source,
      preview: o.previewUrl,
      icon: 'account_circle',
    }));
    return [
      {
        source: 'auto',
        preview: me?.avatarSource === 'auto' ? (me.avatarUrl ?? null) : null,
        icon: 'auto_awesome',
      },
      ...providers,
      { source: 'custom', preview: me?.customAvatarUrl ?? null, icon: 'link' },
      { source: 'none', preview: null, icon: 'person_off' },
    ];
  });

  protected labelKey(source: AvatarSource): string {
    return source === 'google' || source === 'discord' || source === 'telegram'
      ? `account.providers.${source}`
      : `avatarPicker.source.${source}`;
  }

  protected showPreview(c: Choice): string | null {
    return c.preview && !this.broken().has(c.preview) ? c.preview : null;
  }

  protected markBroken(url: string): void {
    this.broken.update((s) => new Set(s).add(url));
  }

  protected select(source: AvatarSource): void {
    this.selected.set(source);
    this.urlError.set(null);
    this.message.set(null);
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    const source = this.selected();
    const url = this.customUrl.value.trim();
    const parsed = updateAvatarSchema.safeParse(
      source === 'custom' ? { source, customUrl: url } : { source },
    );
    if (!parsed.success) {
      this.urlError.set('avatarPicker.errors.urlInvalid');
      return;
    }
    this.saving.set(true);
    this.urlError.set(null);
    this.message.set(null);
    try {
      const me = await firstValueFrom(this.api.changeAvatar(parsed.data));
      this.auth.setMe(me);
      this.selected.set(me.avatarSource);
      this.customUrl.setValue(me.customAvatarUrl ?? '');
      this.message.set({ kind: 'info', key: 'avatarPicker.saved' });
    } catch (err) {
      const e = toApiError(err);
      if (e.code === 'IMAGE_URL_INVALID') {
        const reason = (e.details as { reason?: unknown } | undefined)?.reason;
        const known = (IMAGE_URL_INVALID_REASONS as readonly unknown[]).includes(reason)
          ? (reason as string)
          : 'unreachable';
        this.urlError.set(`errors.imageUrl.${known}`);
      } else if (e.code !== 'UNAUTHENTICATED') {
        // AVATAR_SOURCE_UNAVAILABLE, RATE_LIMITED та інші — текст за кодом.
        this.message.set({ kind: 'error', key: `errors.${e.code}` });
      }
    } finally {
      this.saving.set(false);
    }
  }
}
