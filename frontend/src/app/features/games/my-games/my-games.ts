import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { TranslatePipe } from '@ngx-translate/core';
import { isRestrictedGame, type GameAction, type MyGameCardDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { GamesApi } from '../../../core/games/games.api';
import { ViewModeStore } from '../../../core/view-mode/view-mode.store';
import { ViewsService } from '../../../core/views/views.service';
import {
  toMyGameItemVm,
  type MyGameActionEvent,
  type MyGameItemVm,
} from '../../../core/games/my-game-item.vm';
import {
  ConfirmDialog,
  type ConfirmDialogData,
} from '../../../shared/confirm-dialog/confirm-dialog';
import { confirmCloseDead } from '../dead-games/dead-game-close';
import { openPauseDialog, openResumeDialog, resumedNoticeKey } from '../pause/pause-flow';
import { viewerTimeZone } from '../../../core/i18n/dates';
import { Slot } from '../../../theming/slot';
import type { SlotLinkAction, SlotOutputEvent } from '../../../theming/slots';

/** Дії заголовка сторінки. */
const HEADER_ACTIONS: readonly SlotLinkAction[] = [
  {
    id: 'blacklist',
    labelKey: 'games.my.blacklist',
    icon: 'block',
    link: '/blacklist',
    primary: false,
  },
  { id: 'new-game', labelKey: 'games.my.newGame', icon: 'add', link: '/games/new', primary: true },
];
const EMPTY_ACTION: SlotLinkAction = {
  id: 'new-game',
  labelKey: 'games.my.newGame',
  icon: null,
  link: '/games/new',
  primary: true,
};

/** Повідомлення сторінки: ключ i18n. */
interface Message {
  kind: 'error' | 'info';
  key: string;
}

/**
 * «Мої ігри»: ігри майстра в усіх статусах з діями за статусом. Позначки «давно не
 * проводилась» / «мертва» мають пояснення й дії «Все ок» і «Закрити»; «підозріла» — лише
 * пояснення (закрити гру можна звичайною дією). Що показати й які дії доступні — у
 * `toMyGameItemVm`; рядок малює слот `my-game-item` чинного дизайну.
 */
@Component({
  selector: 'nri-my-games',
  imports: [MatButtonModule, TranslatePipe, Slot],
  templateUrl: './my-games.html',
  styleUrl: './my-games.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MyGames {
  private readonly api = inject(GamesApi);
  private readonly auth = inject(AuthStore);
  private readonly viewMode = inject(ViewModeStore);
  private readonly dialog = inject(MatDialog);

  protected readonly games = signal<MyGameCardDto[] | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly busyId = signal<number | null>(null);
  protected readonly message = signal<Message | null>(null);
  protected readonly seen = inject(ViewsService).tracker('game');
  protected readonly headerActions = HEADER_ACTIONS;
  protected readonly emptyAction = EMPTY_ACTION;

  /** Рядки для слоту: гра + її view-model. */
  protected readonly items = computed<{ game: MyGameCardDto; vm: MyGameItemVm }[] | null>(() => {
    const me = this.auth.me();
    const viewMode = this.viewMode.mode();
    return (
      this.games()?.map((game) => ({
        game,
        vm: toMyGameItemVm(game, { me, seen: this.seen.badge(game.id), viewMode }),
      })) ?? null
    );
  });

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loadFailed.set(false);
    try {
      const games = await firstValueFrom(this.api.mine());
      this.games.set(games);
      this.seen.track(games);
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

  /** Подія зі слоту рядка: дія-кнопка над грою. */
  protected onItemOutput(game: MyGameCardDto, event: SlotOutputEvent): void {
    if (event.name !== 'action') return;
    const { action } = event.value as MyGameActionEvent;
    if (action === 'still-alive') void this.stillAlive(game);
    else if (action === 'close-dead') void this.closeDead(game);
    else if (action === 'pause') void this.pause(game);
    else if (action === 'resume' || action === 'recruit')
      void this.resume(game, action === 'recruit');
    else void this.run(game, action);
  }

  /** «Поставити на паузу»: діалог причини робить запит сам. */
  protected async pause(game: MyGameCardDto): Promise<void> {
    if (this.busyId() !== null) return;
    this.busyId.set(game.id);
    this.message.set(null);
    try {
      const dto = await openPauseDialog(this.dialog, { gameId: game.id, title: game.title });
      if (!dto) return;
      this.patch(game.id, { status: dto.status, nextSessionAt: dto.nextSessionAt });
      this.message.set({ kind: 'info', key: 'games.pause.done.pause' });
      void this.refresh();
    } finally {
      this.busyId.set(null);
    }
  }

  /**
   * «Відновити» / «Оголосити донабір»: діалогу потрібне правило розкладу гри, якого немає в
   * картці, — спершу беремо гру з сервера.
   */
  protected async resume(game: MyGameCardDto, recruit: boolean): Promise<void> {
    if (this.busyId() !== null) return;
    this.busyId.set(game.id);
    this.message.set(null);
    try {
      const full = await firstValueFrom(this.api.get(game.id));
      if (isRestrictedGame(full) || full.status !== 'paused') {
        void this.refresh();
        return;
      }
      const dto = await openResumeDialog(this.dialog, {
        game: full,
        recruit,
        firstStart: full.startedAt === null,
        viewerTimezone: viewerTimeZone(this.auth.me()),
      });
      if (!dto) return;
      this.patch(game.id, { status: dto.status, nextSessionAt: dto.nextSessionAt });
      this.message.set({ kind: 'info', key: resumedNoticeKey(dto, recruit) });
      void this.refresh();
    } catch (err) {
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') this.message.set({ kind: 'error', key: `errors.${code}` });
    } finally {
      this.busyId.set(null);
    }
  }

  /** «Все ок»: позначку «давно не проводилась» / «мертва» знято на 14 днів. */
  protected async stillAlive(game: MyGameCardDto): Promise<void> {
    if (this.busyId() !== null) return;
    await this.act(game, 'stillAlive', async () => {
      const dto = await firstValueFrom(this.api.stillAlive(game.id));
      this.patch(game.id, { staleness: dto.state, suspicious: dto.suspicious });
    });
  }

  /** «Закрити» гру з позначкою: набір → скасована, почата → завершена. */
  protected async closeDead(game: MyGameCardDto): Promise<void> {
    if (this.busyId() !== null) return;
    if (!(await confirmCloseDead(this.dialog, game))) return;
    await this.act(game, 'close', async () => {
      const dto = await firstValueFrom(this.api.closeDead(game.id));
      this.patch(game.id, {
        status: dto.status,
        nextSessionAt: dto.nextSessionAt,
        freeSlots: dto.freeSlots,
        staleness: 'ok',
        suspicious: false,
      });
      void this.refresh();
    });
  }

  private async act(
    game: MyGameCardDto,
    done: string,
    request: () => Promise<void>,
  ): Promise<void> {
    this.busyId.set(game.id);
    this.message.set(null);
    try {
      await request();
      this.message.set({ kind: 'info', key: `games.dead.done.${done}` });
    } catch (err) {
      const { status, code } = toApiError(err);
      if (code === 'UNAUTHENTICATED') return;
      this.message.set({ kind: 'error', key: `errors.${code}` });
      // Стан гри вже інший (закрита, сесію відмічено) — показуємо актуальний.
      if (status === 409) void this.refresh();
    } finally {
      this.busyId.set(null);
    }
  }

  private patch(id: number, changes: Partial<MyGameCardDto>): void {
    this.games.update((list) => (list ?? []).map((g) => (g.id === id ? { ...g, ...changes } : g)));
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
