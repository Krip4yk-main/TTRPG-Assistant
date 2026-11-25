import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { GameAction, GameStatus, MyGameCardDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { GamesApi } from '../../../core/games/games.api';
import { differentZones, formatDateTime, viewerTimeZone } from '../../../core/i18n/dates';
import {
  ConfirmDialog,
  type ConfirmDialogData,
} from '../../../shared/confirm-dialog/confirm-dialog';

/** Дії-переходи, доступні в кожному статусі (редагування — окремо). */
const ACTIONS: Record<GameStatus, GameAction[]> = {
  draft: ['publish', 'cancel'],
  recruiting: ['start', 'cancel'],
  started: ['finish', 'cancel'],
  finished: [],
  cancelled: [],
};

const EDITABLE = new Set<GameStatus>(['draft', 'recruiting', 'started']);
/** Статуси, у яких у гри можуть бути заявки (чернетка — ще ні). */
const HAS_APPLICATIONS = new Set<GameStatus>(['recruiting', 'started', 'finished', 'cancelled']);

/** Повідомлення сторінки: ключ i18n. */
interface Message {
  kind: 'error' | 'info';
  key: string;
}

/** «Мої ігри»: ігри майстра в усіх статусах з діями за статусом. */
@Component({
  selector: 'nri-my-games',
  imports: [RouterLink, MatButtonModule, MatIconModule, TranslatePipe],
  templateUrl: './my-games.html',
  styleUrl: './my-games.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MyGames {
  private readonly api = inject(GamesApi);
  private readonly auth = inject(AuthStore);
  private readonly dialog = inject(MatDialog);

  protected readonly games = signal<MyGameCardDto[] | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly busyId = signal<number | null>(null);
  protected readonly message = signal<Message | null>(null);

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loadFailed.set(false);
    try {
      this.games.set(await firstValueFrom(this.api.mine()));
    } catch (err) {
      if (toApiError(err).code !== 'UNAUTHENTICATED') this.loadFailed.set(true);
    }
  }

  /** Тихе оновлення карток; помилка лишає наявний список. */
  private async refresh(): Promise<void> {
    try {
      this.games.set(await firstValueFrom(this.api.mine()));
    } catch {
      // Список уже показано; лічильники оновляться при наступному відкритті.
    }
  }

  protected actionsFor(status: GameStatus): GameAction[] {
    return ACTIONS[status];
  }

  protected canEdit(status: GameStatus): boolean {
    return EDITABLE.has(status);
  }

  protected hasApplications(status: GameStatus): boolean {
    return HAS_APPLICATIONS.has(status);
  }

  protected systemName(g: MyGameCardDto): string {
    return g.system?.name ?? g.systemOther ?? '';
  }

  protected when(game: MyGameCardDto, iso: string): string {
    const tz = viewerTimeZone(this.auth.me());
    return formatDateTime(iso, tz, { showZone: differentZones(tz, game.timezone) });
  }

  /** Перехід статусу — лише після підтвердження в діалозі. */
  protected async run(game: MyGameCardDto, action: GameAction): Promise<void> {
    if (this.busyId() !== null) return;
    // Старт не має «пробного» режиму: попередження про мінімум — до запиту, за даними картки.
    const key = action === 'start' && game.memberCount < game.minPlayers ? 'startBelowMin' : action;
    const data: ConfirmDialogData = {
      title: `games.confirm.${key}.title`,
      text: `games.confirm.${key}.text`,
      confirm: `games.confirm.${key}.confirm`,
      params: { count: game.memberCount, min: game.minPlayers },
      danger: action === 'cancel' || action === 'finish',
    };
    const ref = this.dialog.open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
      data,
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    if (!(await firstValueFrom(ref.afterClosed()))) return;
    this.busyId.set(game.id);
    this.message.set(null);
    try {
      const dto = await firstValueFrom(this.api.transition(game.id, action));
      this.games.update((list) =>
        (list ?? []).map((g) =>
          g.id === game.id
            ? {
                ...g,
                status: dto.status,
                nextSessionAt: dto.nextSessionAt,
                freeSlots: dto.freeSlots,
              }
            : g,
        ),
      );
      this.message.set({ kind: 'info', key: `games.my.done.${action}` });
      // Перехід змінює й лічильники (скасовані заявки, склад) — беремо їх із сервера.
      void this.refresh();
    } catch (err) {
      const { code } = toApiError(err);
      // 401 уже обробив authInterceptor.
      if (code !== 'UNAUTHENTICATED') this.message.set({ kind: 'error', key: `errors.${code}` });
    } finally {
      this.busyId.set(null);
    }
  }
}
