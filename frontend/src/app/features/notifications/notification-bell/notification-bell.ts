import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { A11yModule } from '@angular/cdk/a11y';
import {
  CdkConnectedOverlay,
  CdkOverlayOrigin,
  type ConnectedPosition,
} from '@angular/cdk/overlay';
import { MatBadgeModule } from '@angular/material/badge';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TranslatePipe } from '@ngx-translate/core';
import type { NotificationDto } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { viewerTimeZone } from '../../../core/i18n/dates';
import {
  type NotificationTime,
  type NotificationView,
  notificationTime,
  notificationView,
} from '../../../core/notifications/notification-view';
import { NotificationsStore } from '../../../core/notifications/notifications.store';

/** Найбільше число на бейджі; більше — «99+». */
export const BADGE_MAX = 99;

interface Row {
  n: NotificationDto;
  view: NotificationView;
  time: NotificationTime;
}

/**
 * Дзвіночок у шапці: бейдж непрочитаних і панель зі списком сповіщень (CDK overlay —
 * усередині можна натискати «Ще» без закриття, на відміну від mat-menu).
 */
@Component({
  selector: 'nri-notification-bell',
  imports: [
    RouterLink,
    A11yModule,
    CdkConnectedOverlay,
    CdkOverlayOrigin,
    MatBadgeModule,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    TranslatePipe,
  ],
  templateUrl: './notification-bell.html',
  styleUrl: './notification-bell.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotificationBell {
  protected readonly store = inject(NotificationsStore);
  private readonly auth = inject(AuthStore);
  private readonly trigger = viewChild.required('trigger', {
    read: ElementRef<HTMLButtonElement>,
  });

  protected readonly open = signal(false);
  protected readonly count = this.store.unreadCount;
  protected readonly badge = computed(() => {
    const c = this.count();
    return c > BADGE_MAX ? `${BADGE_MAX}+` : String(c);
  });
  /** Оголошення для читачів екрана — лише коли лічильник змінився (не при кожному рендері). */
  protected readonly announcement = signal<number | null>(null);
  private readonly now = signal(Date.now());
  private readonly timeZone = computed(() => viewerTimeZone(this.auth.me()));

  protected readonly rows = computed<Row[]>(() => {
    const tz = this.timeZone();
    const now = this.now();
    return this.store.items().map((n) => ({
      n,
      view: notificationView(n, tz),
      time: notificationTime(n.createdAt, tz, now),
    }));
  });

  protected readonly positions: ConnectedPosition[] = [
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 4 },
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -4 },
  ];

  constructor() {
    let previous: number | null = null;
    effect(() => {
      const c = this.count();
      const known = this.store.unreadKnown();
      untracked(() => {
        // Перше значення з сервера (завантаження сторінки) не оголошуємо — лише зміни.
        if (!known) previous = null;
        else if (previous !== null && c !== previous) this.announcement.set(c);
        if (known) previous = c;
      });
    });
    // Стор закрив панель (вихід/зміна користувача) — закриваємо й тут.
    effect(() => {
      if (!this.store.panelOpen()) untracked(() => this.open.set(false));
    });
  }

  protected toggle(): void {
    if (this.open()) this.close(true);
    else this.show();
  }

  private show(): void {
    this.now.set(Date.now());
    this.open.set(true);
    this.store.setPanelOpen(true);
    void this.store.loadFirst();
  }

  protected close(restoreFocus = false): void {
    if (!this.open()) return;
    this.open.set(false);
    this.store.setPanelOpen(false);
    if (restoreFocus) this.trigger().nativeElement.focus();
  }

  /** Клік поза панеллю; клік по самому дзвіночку обробляє `toggle()`. */
  protected onOutsideClick(event: MouseEvent): void {
    const target = event.target as Node | null;
    if (target && this.trigger().nativeElement.contains(target)) return;
    this.close();
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close(true);
    }
  }

  protected openItem(n: NotificationDto): void {
    void this.store.markRead(n);
    this.close();
  }

  protected markAll(): void {
    void this.store.markAllRead();
  }

  protected loadMore(): void {
    void this.store.loadMore();
  }

  protected retry(): void {
    void this.store.loadFirst();
  }
}
