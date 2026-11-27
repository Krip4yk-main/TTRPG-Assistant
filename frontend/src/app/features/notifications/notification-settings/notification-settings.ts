import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { type MatChipListboxChange, MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import {
  NOTIFICATION_CATEGORIES,
  QUIET_HOURS_TIMES,
  REMINDER_OFFSETS,
  SITE_OPTIONAL_CATEGORIES,
  type NotificationCategory,
  type NotificationPrefsDto,
  type QuietHours,
  type ReminderOffset,
  type SiteOptionalCategory,
} from '@nri/shared';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { NotificationsApi } from '../../../core/notifications/notifications.api';

type TelegramPrefs = Record<NotificationCategory, boolean>;
type SitePrefs = Record<SiteOptionalCategory, boolean>;

/**
 * `/settings/notifications`: що вимкнути на сайті («Розклад»), Telegram за категоріями, тихі
 * години Telegram і моменти нагадувань про сесії.
 */
@Component({
  selector: 'nri-notification-settings',
  imports: [
    RouterLink,
    MatButtonModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
    MatSelectModule,
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
  /** Категорії, які можна вимкнути й на сайті (зараз — «Розклад»). */
  protected readonly siteCategories = SITE_OPTIONAL_CATEGORIES;
  /** Від найближчого до найдальшого (15 хв … 48 год). */
  protected readonly offsets = REMINDER_OFFSETS;
  /** Варіанти часу тихих годин: 00:00 … 23:30 з кроком 30 хв. */
  protected readonly quietTimes = QUIET_HOURS_TIMES;
  protected readonly timeZone = computed(() => this.auth.me()?.timezone ?? 'Europe/Kyiv');

  protected readonly hasTelegram = computed(
    () => this.auth.me()?.identities.some((i) => i.provider === 'telegram') ?? false,
  );

  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly saveError = signal<string | null>(null);
  protected readonly telegram = signal<TelegramPrefs | null>(null);
  protected readonly site = signal<SitePrefs | null>(null);
  protected readonly reminderOffsets = signal<ReminderOffset[]>([]);
  protected readonly remindersOff = computed(() => this.reminderOffsets().length === 0);
  protected readonly quietHours = signal<QuietHours | null>(null);
  /** Початок і кінець збігаються — інтервал порожній, бекенд відхилить. */
  protected readonly quietInvalid = computed(() => {
    const q = this.quietHours();
    return q !== null && q.start === q.end;
  });
  /** Останній збережений (завантажений) стан — для «є незбережені зміни». */
  private readonly saved = signal<NotificationPrefsDto | null>(null);
  protected readonly dirty = computed(() => {
    const saved = this.saved();
    const telegram = this.telegram();
    const site = this.site();
    const quiet = this.quietHours();
    if (!saved || !telegram || !site || !quiet) return false;
    const offsets = (a: readonly number[]) => [...a].sort((x, y) => y - x).join(',');
    return (
      this.categories.some((c) => telegram[c] !== saved.telegram[c]) ||
      this.siteCategories.some((c) => site[c] !== saved.site[c]) ||
      offsets(this.reminderOffsets()) !== offsets(saved.reminderOffsets) ||
      quiet.enabled !== saved.quietHours.enabled ||
      quiet.start !== saved.quietHours.start ||
      quiet.end !== saved.quietHours.end
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

  protected setSite(category: SiteOptionalCategory, value: boolean): void {
    this.site.update((s) => (s ? { ...s, [category]: value } : s));
  }

  protected setQuiet(patch: Partial<QuietHours>): void {
    this.quietHours.update((q) => (q ? { ...q, ...patch } : q));
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
    const site = this.site();
    const quietHours = this.quietHours();
    if (!telegram || !site || !quietHours || this.saving() || !this.dirty()) return;
    if (this.quietInvalid()) return;
    this.saving.set(true);
    this.saveError.set(null);
    try {
      const saved = await firstValueFrom(
        this.api.updatePrefs({
          telegram,
          site,
          reminderOffsets: [...this.reminderOffsets()].sort((a, b) => b - a),
          quietHours,
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
    this.site.set({ ...prefs.site });
    this.reminderOffsets.set([...prefs.reminderOffsets]);
    this.quietHours.set({ ...prefs.quietHours });
  }
}
