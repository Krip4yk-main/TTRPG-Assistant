import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  Router,
  type UrlTree,
  RouterLink,
} from '@angular/router';
import { filter, firstValueFrom, take } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
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
import {
  ConfirmDialog,
  type ConfirmDialogData,
} from '../../../shared/confirm-dialog/confirm-dialog';
import { NotificationsStore } from '../../../core/notifications/notifications.store';
import { AcceptedNoticeMoment } from '../../../theming/moments/accepted-notice';
import { ThemeService } from '../../../theming/theme.service';

/** Найбільше число на бейджі; більше — «99+». */
export const BADGE_MAX = 99;

interface Row {
  n: NotificationDto;
  view: NotificationView;
  time: NotificationTime;
  /** Посилання як `UrlTree`: рядок із `?poll=…` у `routerLink` закодував би `?`. */
  url: UrlTree;
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
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly themes = inject(ThemeService);
  private readonly acceptedNotice = inject(AcceptedNoticeMoment);
  private readonly trigger = viewChild.required('trigger', {
    read: ElementRef<HTMLButtonElement>,
  });

  protected readonly open = signal(false);
  protected readonly count = this.store.unreadCount;
  protected readonly hasRead = computed(() => this.store.items().some((n) => n.readAt));
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
      url: this.router.parseUrl(n.link),
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
    // Фірмова анімація `acceptedNotice`: уперше показане непрочитане «вас прийнято» (при
    // відкритті панелі чи щойно підмішане згори) — один раз на сповіщення, на найновішому.
    // Поки чинний дизайн його не анімує (немає ефекту, вимкнено, зменшений рух), сповіщення
    // не вважається зіграним — програється пізніше під дизайном, що анімує.
    effect(() => {
      if (!this.open() || !this.store.loaded()) return;
      if (!this.themes.effectEnabled('acceptedNotice')) return;
      const items = this.store.items();
      untracked(() => {
        const [fresh] = this.acceptedNotice.claim(items);
        if (fresh) this.playAccepted(fresh.id);
      });
    });
    // Стор закрив панель (вихід/зміна користувача) — закриваємо й тут.
    effect(() => {
      if (!this.store.panelOpen()) untracked(() => this.open.set(false));
    });
  }

  private playAccepted(id: number): void {
    this.themes.preloadEffect('acceptedNotice');
    afterNextRender(
      () => {
        const row = this.document.querySelector<HTMLElement>(
          `#notifications-panel [data-notification-id="${id}"]`,
        );
        if (row) void this.themes.playEffect('acceptedNotice', row);
      },
      { injector: this.injector },
    );
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
    // Клік у діалозі підтвердження (він над панеллю) не закриває панель.
    if (this.dialog.openDialogs.length > 0) return;
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

  /**
   * Перехід за сповіщенням. Панель (з елементом у фокусі) зникає, тож фокус переносимо:
   * на новій сторінці — на її заголовок (або `main`), якщо сторінка та сама — на дзвіночок.
   */
  protected openItem(n: NotificationDto): void {
    void this.store.markRead(n);
    if (this.router.url === n.link) {
      this.close(true);
      return;
    }
    this.close();
    this.router.events
      .pipe(
        filter(
          (e) =>
            e instanceof NavigationEnd ||
            e instanceof NavigationCancel ||
            e instanceof NavigationError,
        ),
        take(1),
      )
      .subscribe((e) => {
        if (e instanceof NavigationEnd) {
          afterNextRender(() => this.focusMain(), { injector: this.injector });
        } else {
          this.trigger().nativeElement.focus();
        }
      });
  }

  private focusMain(): void {
    const main = this.document.getElementById('main-content');
    const heading = main?.querySelector<HTMLElement>('h1');
    const target = heading ?? main;
    if (!target) return;
    if (target === heading && !heading.hasAttribute('tabindex')) heading.tabIndex = -1;
    target.focus();
  }

  protected markAll(): void {
    void this.store.markAllRead();
  }

  protected remove(n: NotificationDto): void {
    void this.store.remove(n);
  }

  /** Видалити прочитані — лише після підтвердження (діалог відкривається над панеллю). */
  protected async removeRead(): Promise<void> {
    const ref = this.dialog.open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
      data: {
        title: 'notifications.panel.removeRead.title',
        text: 'notifications.panel.removeRead.text',
        confirm: 'notifications.panel.removeRead.confirm',
        danger: true,
      },
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    if (!(await firstValueFrom(ref.afterClosed()))) return;
    await this.store.removeRead();
  }

  protected loadMore(): void {
    void this.store.loadMore();
  }

  protected retry(): void {
    void this.store.loadFirst();
  }
}
