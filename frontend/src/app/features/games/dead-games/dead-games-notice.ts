import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { TranslatePipe } from '@ngx-translate/core';
import type { MyDeadGameDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { GamesApi } from '../../../core/games/games.api';
import { formatDateTime, viewerTimeZone } from '../../../core/i18n/dates';
import { confirmCloseDead } from './dead-game-close';

/**
 * Пояснення відмови `GAME_CREATION_BLOCKED` у формі нової гри: «мертві» ігри майстра з діями
 * «Все ок» і «Закрити». Коли таких ігор не лишилось, віддає `resolved` — гру можна створювати.
 * Список береться з `GET /api/me/dead-games` (актуальний стан); якщо він не завантажився —
 * показуються посилання на ігри з відповіді 409 (`ids`).
 */
@Component({
  selector: 'nri-dead-games-notice',
  imports: [RouterLink, MatButtonModule, TranslatePipe],
  templateUrl: './dead-games-notice.html',
  styleUrl: './dead-games-notice.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeadGamesNotice {
  private readonly api = inject(GamesApi);
  private readonly auth = inject(AuthStore);
  private readonly dialog = inject(MatDialog);

  /** `details.deadGameIds` з відповіді 409. */
  readonly ids = input.required<readonly number[]>();
  /** «Мертвих» ігор більше немає. */
  readonly resolved = output<void>();

  protected readonly items = signal<MyDeadGameDto[] | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly busyId = signal<number | null>(null);
  /** Помилка дії (ключ i18n). */
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loadFailed.set(false);
    try {
      const dto = await firstValueFrom(this.api.myDeadGames());
      const dead = new Set(dto.deadGameIds);
      this.setItems(dto.items.filter((g) => dead.has(g.id)));
    } catch (err) {
      if (toApiError(err).code !== 'UNAUTHENTICATED') this.loadFailed.set(true);
    }
  }

  protected since(g: MyDeadGameDto): string | null {
    return g.lastActivityAt
      ? formatDateTime(g.lastActivityAt, viewerTimeZone(this.auth.me()))
      : null;
  }

  protected async stillAlive(g: MyDeadGameDto): Promise<void> {
    await this.act(g, () => firstValueFrom(this.api.stillAlive(g.id)));
  }

  protected async close(g: MyDeadGameDto): Promise<void> {
    if (this.busyId() !== null) return;
    if (!(await confirmCloseDead(this.dialog, g))) return;
    await this.act(g, () => firstValueFrom(this.api.closeDead(g.id)));
  }

  private async act(g: MyDeadGameDto, request: () => Promise<unknown>): Promise<void> {
    if (this.busyId() !== null) return;
    this.busyId.set(g.id);
    this.error.set(null);
    try {
      await request();
      this.setItems((this.items() ?? []).filter((x) => x.id !== g.id));
    } catch (err) {
      const { status, code } = toApiError(err);
      if (status === 409) {
        // Стан гри вже змінився (закрита, сесію відмічено) — перечитуємо список.
        await this.load();
      } else if (code !== 'UNAUTHENTICATED') {
        this.error.set(`errors.${code}`);
      }
    } finally {
      this.busyId.set(null);
    }
  }

  private setItems(list: MyDeadGameDto[]): void {
    this.items.set(list);
    if (list.length === 0) this.resolved.emit();
  }
}
