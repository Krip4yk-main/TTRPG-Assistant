import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import {
  CALENDAR_IMPORT_ERROR_CODES,
  CALENDAR_IMPORT_URL_MAX,
  type CalendarImportErrorCode,
  type CalendarImportStatusDto,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { CalendarImportApi } from '../../../core/calendar/calendar-import.api';
import { formatDateTime, viewerTimeZone } from '../../../core/i18n/dates';
import {
  ConfirmDialog,
  type ConfirmDialogData,
} from '../../../shared/confirm-dialog/confirm-dialog';

interface Message {
  kind: 'error' | 'info';
  key: string;
  params?: Record<string, string | number>;
}

const isReason = (r: unknown): r is CalendarImportErrorCode =>
  typeof r === 'string' && (CALENDAR_IMPORT_ERROR_CODES as readonly string[]).includes(r);

/**
 * «Імпорт календаря» на сторінці «Мій календар»: вставити приватне iCal-посилання (з
 * підказкою, де його взяти в Google / Apple / Outlook), стан підключення (лише хост, остання
 * синхронізація, причина невдачі, зламаний імпорт), «Оновити зараз» і «Відключити». Посилання
 * сервер ніколи не повертає.
 */
@Component({
  selector: 'nri-calendar-import',
  imports: [MatButtonModule, MatIconModule, TranslatePipe],
  templateUrl: './calendar-import.html',
  styleUrl: './calendar-import.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CalendarImport {
  private readonly api = inject(CalendarImportApi);
  private readonly auth = inject(AuthStore);
  private readonly dialog = inject(MatDialog);

  protected readonly maxLength = CALENDAR_IMPORT_URL_MAX;
  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly status = signal<CalendarImportStatusDto | null>(null);
  protected readonly url = signal('');
  /** Підключено, але користувач хоче замінити посилання. */
  protected readonly replacing = signal(false);
  protected readonly busy = signal<'connect' | 'sync' | 'disconnect' | null>(null);
  protected readonly message = signal<Message | null>(null);
  private readonly now = signal(Date.now());

  private readonly zone = computed(() => viewerTimeZone(this.auth.me()));
  protected readonly showForm = computed(() => {
    const s = this.status();
    return !!s && s.available && (!s.connected || this.replacing());
  });
  protected readonly lastSync = computed(() => {
    const at = this.status()?.lastSyncAt;
    return at ? formatDateTime(at, this.zone()) : null;
  });
  protected readonly lastAttempt = computed(() => {
    const at = this.status()?.lastAttemptAt;
    return at ? formatDateTime(at, this.zone()) : null;
  });
  /** «Оновити» ще не можна (5 хв між ручними оновленнями). */
  protected readonly syncLockedUntil = computed(() => {
    const at = this.status()?.nextManualSyncAt;
    return at && Date.parse(at) > this.now() ? formatDateTime(at, this.zone()) : null;
  });

  constructor() {
    const clock = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(clock));
    void this.load();
  }

  protected async load(): Promise<void> {
    this.state.set('loading');
    try {
      this.status.set(await firstValueFrom(this.api.status()));
      this.state.set('ready');
    } catch (err) {
      if (toApiError(err).code !== 'UNAUTHENTICATED') this.state.set('error');
    }
  }

  protected setUrl(value: string): void {
    this.url.set(value);
  }

  protected startReplace(): void {
    this.replacing.set(true);
    this.message.set(null);
  }

  protected cancelReplace(): void {
    this.replacing.set(false);
    this.url.set('');
  }

  protected async connect(): Promise<void> {
    const url = this.url().trim();
    if (this.busy()) return;
    this.message.set(null);
    if (!url) {
      this.message.set({ kind: 'error', key: 'calendar.import.urlRequired' });
      return;
    }
    this.busy.set('connect');
    try {
      const s = await firstValueFrom(this.api.connect(url));
      this.status.set(s);
      this.now.set(Date.now());
      this.url.set('');
      this.replacing.set(false);
      this.message.set({ kind: 'info', key: 'calendar.import.connected' });
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy.set(null);
    }
  }

  protected async sync(): Promise<void> {
    if (this.busy()) return;
    this.busy.set('sync');
    this.message.set(null);
    try {
      const s = await firstValueFrom(this.api.sync());
      this.status.set(s);
      this.now.set(Date.now());
      this.message.set(
        s.lastError
          ? { kind: 'error', key: `calendar.import.errors.${s.lastError}` }
          : { kind: 'info', key: 'calendar.import.synced' },
      );
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy.set(null);
    }
  }

  protected async disconnect(): Promise<void> {
    if (this.busy()) return;
    const ref = this.dialog.open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
      data: {
        title: 'calendar.import.disconnectConfirm.title',
        text: 'calendar.import.disconnectConfirm.text',
        confirm: 'calendar.import.disconnectConfirm.confirm',
        danger: true,
      },
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    if (!(await firstValueFrom(ref.afterClosed()))) return;
    this.busy.set('disconnect');
    this.message.set(null);
    try {
      await firstValueFrom(this.api.disconnect());
      this.status.update((s) =>
        s
          ? {
              ...s,
              connected: false,
              host: null,
              lastSyncAt: null,
              lastAttemptAt: null,
              lastError: null,
              failures: 0,
              broken: false,
              eventsCount: 0,
              truncated: false,
              nextManualSyncAt: null,
            }
          : s,
      );
      this.replacing.set(false);
      this.message.set({ kind: 'info', key: 'calendar.import.disconnected' });
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy.set(null);
    }
  }

  private fail(err: unknown): void {
    const { code, details } = toApiError(err);
    if (code === 'UNAUTHENTICATED') return;
    const d = (details ?? {}) as { reason?: unknown; retryAfterSec?: unknown };
    if (
      (code === 'CALENDAR_IMPORT_FAILED' || code === 'CALENDAR_IMPORT_URL_INVALID') &&
      isReason(d.reason)
    ) {
      this.message.set({ kind: 'error', key: `calendar.import.errors.${d.reason}` });
    } else if (code === 'RATE_LIMITED') {
      if (d.reason === 'busy') {
        this.message.set({ kind: 'error', key: 'calendar.import.busy' });
      } else if (typeof d.retryAfterSec === 'number') {
        this.message.set({
          kind: 'error',
          key: 'calendar.import.rateLimited',
          params: { min: Math.max(1, Math.ceil(d.retryAfterSec / 60)) },
        });
      } else {
        this.message.set({ kind: 'error', key: 'errors.RATE_LIMITED' });
      }
    } else if (code === 'NOT_FOUND') {
      // Посилання вже відключено (інша вкладка) — показуємо актуальний стан.
      void this.load();
      this.message.set({ kind: 'info', key: 'calendar.import.disconnected' });
    } else {
      this.message.set({ kind: 'error', key: `errors.${code}` });
    }
  }
}
