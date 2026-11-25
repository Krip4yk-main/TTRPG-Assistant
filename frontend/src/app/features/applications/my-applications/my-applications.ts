import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import {
  APPLICATION_STATUSES,
  isRestrictedGame,
  type ApplicationStatus,
  type GameCardDto,
  type MyApplicationDto,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { ApplicationsApi } from '../../../core/applications/applications.api';
import { AuthStore } from '../../../core/auth/auth.store';
import { ChangeWatcher } from '../../../core/realtime/change-watcher';
import { changedKeys, Highlighter } from '../../../core/realtime/highlight';
import { ViewsService } from '../../../core/views/views.service';
import { UpdateBanner } from '../../../shared/update-banner/update-banner';
import { formatDateTime, viewerTimeZone } from '../../../core/i18n/dates';
import {
  ConfirmDialog,
  type ConfirmDialogData,
} from '../../../shared/confirm-dialog/confirm-dialog';

/** Повідомлення сторінки: ключ i18n. */
interface Message {
  kind: 'error' | 'info';
  key: string;
}

interface Group {
  status: ApplicationStatus;
  items: MyApplicationDto[];
}

/**
 * «Мої заявки» (`/my-applications`): заявки гравця за статусами (`pending` першими),
 * картка гри (обмежена гра — лише назва й позначка), відповіді майстра на мої обмеження,
 * причина скасування й «Відкликати» для `pending`.
 */
@Component({
  selector: 'nri-my-applications',
  imports: [RouterLink, MatButtonModule, MatIconModule, TranslatePipe, UpdateBanner],
  templateUrl: './my-applications.html',
  styleUrl: './my-applications.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MyApplications {
  private readonly api = inject(ApplicationsApi);
  private readonly auth = inject(AuthStore);
  private readonly dialog = inject(MatDialog);

  protected readonly items = signal<MyApplicationDto[] | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly busyId = signal<number | null>(null);
  protected readonly message = signal<Message | null>(null);
  protected readonly seen = inject(ViewsService).tracker('application');
  protected readonly flash = new Highlighter<number>();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  /** Пінги `applications` в особисту кімнату автора — будь-якої гри. */
  private readonly watch = inject(ChangeWatcher).open({ scopes: ['applications'] });
  protected readonly hasUpdates = computed(() => this.watch.pending().size > 0);
  protected readonly refreshing = signal(false);

  /** Непорожні групи в порядку `APPLICATION_STATUSES`; у групі — новіші першими. */
  protected readonly groups = computed<Group[]>(() => {
    const list = this.items() ?? [];
    return APPLICATION_STATUSES.map((status) => ({
      status,
      items: list
        .filter((a) => a.status === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    })).filter((g) => g.items.length > 0);
  });

  constructor() {
    void this.load();
    inject(DestroyRef).onDestroy(() => {
      this.watch.stop();
      this.flash.dispose();
    });
  }

  /** `silent` — помилка не замінює показаний список (оновлення за банером). */
  protected async load(silent = false): Promise<boolean> {
    if (!silent) this.loadFailed.set(false);
    try {
      const items = await firstValueFrom(this.api.mine());
      this.items.set(items);
      this.seen.track(items);
      return true;
    } catch (err) {
      if (!silent && toApiError(err).code !== 'UNAUTHENTICATED') this.loadFailed.set(true);
      return false;
    }
  }

  /** «Оновити» на банері: перечитати заявки й підсвітити нові та змінені. */
  protected async refreshUpdates(): Promise<void> {
    if (this.refreshing()) return;
    const scopes = this.watch.take();
    this.refreshing.set(true);
    const before = this.items();
    try {
      if (await this.load(true)) {
        const after = this.items();
        if (after && after !== before) this.flash.flash(changedKeys(before, after, (a) => a.id));
      } else {
        // Не вдалося перечитати — банер лишається.
        this.watch.restore(scopes);
      }
    } finally {
      this.refreshing.set(false);
    }
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>('h1')?.focus(), {
      injector: this.injector,
    });
  }

  /** Повна картка гри або `null` для обмеженої (18+/21+, яку глядач не проходить). */
  protected fullGame(a: MyApplicationDto): GameCardDto | null {
    return isRestrictedGame(a.game) ? null : a.game;
  }

  protected systemName(g: GameCardDto): string {
    return g.system?.name ?? g.systemOther ?? '';
  }

  protected when(iso: string): string {
    return formatDateTime(iso, viewerTimeZone(this.auth.me()));
  }

  /** Відкликати `pending`-заявку — лише після підтвердження. */
  protected async withdraw(a: MyApplicationDto): Promise<void> {
    if (this.busyId() !== null) return;
    const ref = this.dialog.open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
      data: {
        title: 'games.applications.confirmWithdraw.title',
        text: 'games.applications.confirmWithdraw.text',
        confirm: 'games.applications.confirmWithdraw.confirm',
        danger: true,
      },
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    if (!(await firstValueFrom(ref.afterClosed()))) return;
    this.busyId.set(a.id);
    this.message.set(null);
    this.watch.quiet(['applications']);
    try {
      const dto = await firstValueFrom(this.api.withdraw(a.id));
      this.items.update((list) =>
        (list ?? []).map((x) => (x.id === a.id ? { ...dto, game: x.game, seen: x.seen } : x)),
      );
      this.message.set({ kind: 'info', key: 'games.applications.my.withdrawn' });
    } catch (err) {
      const { code } = toApiError(err);
      // 401 уже обробив authInterceptor.
      if (code !== 'UNAUTHENTICATED') {
        this.message.set({ kind: 'error', key: `errors.${code}` });
        // Стан заявки міг змінитись (затверджено/скасовано) — тихо оновлюємо список.
        void this.load();
      }
    } finally {
      this.busyId.set(null);
    }
  }
}
