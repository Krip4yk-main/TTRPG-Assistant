import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { type MatChipListboxChange, MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import {
  NOTIFICATION_CATEGORIES,
  REMINDER_OFFSETS,
  type NotificationCategory,
  type NotificationPrefsDto,
  type ReminderOffset,
} from '@nri/shared';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { NotificationsApi } from '../../../core/notifications/notifications.api';

type TelegramPrefs = Record<NotificationCategory, boolean>;

/** `/settings/notifications`: Telegram за категоріями й моменти нагадувань про сесії. */
@Component({
  selector: 'nri-notification-settings',
  imports: [
    RouterLink,
    MatButtonModule,
    MatChipsModule,
    MatIconModule,
    MatSlideToggleModule,
    TranslatePipe,
  ],
  templateUrl: './notification-settings.html',
  styleUrl: './notification-settings.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotificationSettings {
  private readonly api = inject(NotificationsApi);
  private readonly auth = inject(AuthStore);
  private readonly snackBar = inject(MatSnackBar);
  private readonly translate = inject(TranslateService);

  protected readonly categories = NOTIFICATION_CATEGORIES;
  /** Від найближчого до найдальшого (15 хв … 48 год). */
  protected readonly offsets = REMINDER_OFFSETS;

  protected readonly hasTelegram = computed(
    () => this.auth.me()?.identities.some((i) => i.provider === 'telegram') ?? false,
  );

  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly saveError = signal<string | null>(null);
  protected readonly telegram = signal<TelegramPrefs | null>(null);
  protected readonly reminderOffsets = signal<ReminderOffset[]>([]);
  protected readonly remindersOff = computed(() => this.reminderOffsets().length === 0);
  /** Останній збережений (завантажений) стан — для «є незбережені зміни». */
  private readonly saved = signal<NotificationPrefsDto | null>(null);
  protected readonly dirty = computed(() => {
    const saved = this.saved();
    const telegram = this.telegram();
    if (!saved || !telegram) return false;
    const offsets = (a: readonly number[]) => [...a].sort((x, y) => y - x).join(',');
    return (
      this.categories.some((c) => telegram[c] !== saved.telegram[c]) ||
      offsets(this.reminderOffsets()) !== offsets(saved.reminderOffsets)
    );
  });

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      this.apply(await firstValueFrom(this.api.prefs()));
    } catch (err) {
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') this.loadError.set('notifications.settings.loadError');
    } finally {
      this.loading.set(false);
    }
  }

  protected setTelegram(category: NotificationCategory, value: boolean): void {
    this.telegram.update((t) => (t ? { ...t, [category]: value } : t));
  }

  protected setOffsets(event: MatChipListboxChange): void {
    const value = (event.value ?? []) as ReminderOffset[];
    this.reminderOffsets.set([...value]);
  }

  protected isOffsetSelected(offset: ReminderOffset): boolean {
    return this.reminderOffsets().includes(offset);
  }

  protected async save(): Promise<void> {
    const telegram = this.telegram();
    if (!telegram || this.saving() || !this.dirty()) return;
    this.saving.set(true);
    this.saveError.set(null);
    try {
      const saved = await firstValueFrom(
        this.api.updatePrefs({
          telegram,
          reminderOffsets: [...this.reminderOffsets()].sort((a, b) => b - a),
        }),
      );
      this.apply(saved);
      this.snackBar.open(this.translate.instant('notifications.settings.saved') as string, '', {
        duration: 4000,
      });
    } catch (err) {
      const { code } = toApiError(err);
      // 401 уже обробив authInterceptor.
      if (code !== 'UNAUTHENTICATED') this.saveError.set(`errors.${code}`);
    } finally {
      this.saving.set(false);
    }
  }

  private apply(prefs: NotificationPrefsDto): void {
    this.saved.set(prefs);
    this.telegram.set({ ...prefs.telegram });
    this.reminderOffsets.set([...prefs.reminderOffsets]);
  }
}
