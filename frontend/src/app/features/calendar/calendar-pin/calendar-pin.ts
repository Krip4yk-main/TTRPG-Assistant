import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { CalendarApi } from '../../../core/calendar/calendar.api';

/**
 * «Додати в мій календар» на сторінці гри (майстру й учасникам). Якщо в налаштуваннях
 * акаунта ввімкнено автозайнятість — сесії гри і так у календарі, перемикача немає.
 * Інакше перемикач додає/прибирає гру із закріплених (`pinned-games`).
 */
@Component({
  selector: 'nri-calendar-pin',
  imports: [MatSlideToggleModule, RouterLink, TranslatePipe],
  templateUrl: './calendar-pin.html',
  styleUrl: './calendar-pin.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CalendarPin {
  private readonly api = inject(CalendarApi);

  readonly gameId = input.required<number>();

  /** `null` — ще завантажується (або не вдалося — блок необов'язковий). */
  protected readonly mode = signal<'auto' | 'manual' | null>(null);
  protected readonly pinned = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      const id = this.gameId();
      untracked(() => void this.load(id));
    });
  }

  protected async toggle(on: boolean): Promise<void> {
    if (this.busy()) return;
    const id = this.gameId();
    this.busy.set(true);
    this.error.set(null);
    this.pinned.set(on);
    try {
      await firstValueFrom(on ? this.api.pin(id) : this.api.unpin(id), { defaultValue: null });
    } catch (err) {
      this.pinned.set(!on);
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') this.error.set(`errors.${code}`);
    } finally {
      this.busy.set(false);
    }
  }

  private async load(gameId: number): Promise<void> {
    this.mode.set(null);
    try {
      const { calendarAutoBusy } = await firstValueFrom(this.api.settings());
      if (calendarAutoBusy) {
        this.mode.set('auto');
        return;
      }
      const { gameIds } = await firstValueFrom(this.api.pinnedGames());
      this.pinned.set(gameIds.includes(gameId));
      this.mode.set('manual');
    } catch {
      this.mode.set(null);
    }
  }
}
