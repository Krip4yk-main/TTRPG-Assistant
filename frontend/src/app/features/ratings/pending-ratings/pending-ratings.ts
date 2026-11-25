import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { RatingTargetsDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth.store';
import { GamesApi } from '../../../core/games/games.api';
import { viewerTimeZone } from '../../../core/i18n/dates';
import { PendingRatingsStore } from '../../../core/ratings/pending-ratings.store';
import { formatDay } from '../../../core/ratings/rating-format';

interface Row {
  key: string;
  gameId: number;
  sessionId: number | null;
  names: string[];
  closes: string | null;
  queryParams: Record<string, number> | null;
}

/**
 * Сторінка «Оцінити» (`/ratings`): набори з відкритими цілями (після сесії чи підсумкові),
 * найближчий дедлайн першим, з посиланням на форму. Назви ігор довантажуються окремо
 * (по одному запиту на гру — їх зазвичай одиниці).
 */
@Component({
  selector: 'nri-pending-ratings',
  imports: [RouterLink, MatButtonModule, MatIconModule, TranslatePipe],
  templateUrl: './pending-ratings.html',
  styleUrl: './pending-ratings.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PendingRatings {
  protected readonly store = inject(PendingRatingsStore);
  private readonly games = inject(GamesApi);
  private readonly auth = inject(AuthStore);

  protected readonly titles = signal<ReadonlyMap<number, string>>(new Map());
  private readonly requested = new Set<number>();

  protected readonly rows = computed<Row[] | null>(() => {
    const sets = this.store.sets();
    if (!sets) return null;
    const tz = viewerTimeZone(this.auth.me());
    return sets.map((s) => this.row(s, tz)).filter((r) => r.names.length > 0);
  });

  constructor() {
    void this.store.refresh();
    effect(() => {
      for (const s of this.store.sets() ?? []) void this.loadTitle(s.gameId);
    });
  }

  protected retry(): void {
    void this.store.refresh();
  }

  private row(s: RatingTargetsDto, tz: string): Row {
    const open = s.targets.filter((t) => t.state === 'open');
    // Дедлайн набору — найближчий серед відкритих (у межах набору він зазвичай один).
    const deadlines = open.map((t) => t.closesAt).filter((d): d is string => d !== null);
    const closesAt = deadlines.sort()[0] ?? null;
    return {
      key: `${s.gameId}:${s.sessionId ?? 'final'}`,
      gameId: s.gameId,
      sessionId: s.sessionId,
      names: open.map((t) => t.nickname),
      closes: closesAt ? formatDay(closesAt, tz) : null,
      queryParams: s.sessionId === null ? null : { session: s.sessionId },
    };
  }

  private async loadTitle(gameId: number): Promise<void> {
    if (this.requested.has(gameId)) return;
    this.requested.add(gameId);
    try {
      const g = await firstValueFrom(this.games.get(gameId));
      this.titles.update((m) => new Map(m).set(gameId, g.title));
    } catch {
      // Без назви — показуємо «Гра №…».
    }
  }
}
