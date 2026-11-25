import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { RatingTargetsDto } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { formatDateTime, viewerTimeZone } from '../../../core/i18n/dates';
import { PendingRatingsStore } from '../../../core/ratings/pending-ratings.store';
import { formatDeadline } from '../../../core/ratings/rating-format';

interface Row {
  key: string;
  gameId: number;
  title: string;
  sessionId: number | null;
  /** Початок сесії для сесійного набору (у поясі глядача). */
  sessionWhen: string | null;
  names: string[];
  closes: string | null;
  queryParams: Record<string, number> | null;
}

/**
 * Сторінка «Оцінити» (`/ratings`): набори з відкритими цілями (після сесії чи підсумкові),
 * найближчий дедлайн першим, з посиланням на форму. Назва гри й дата сесії — у самому наборі.
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
  private readonly auth = inject(AuthStore);

  protected readonly rows = computed<Row[] | null>(() => {
    const sets = this.store.sets();
    if (!sets) return null;
    const tz = viewerTimeZone(this.auth.me());
    return sets.map((s) => this.row(s, tz)).filter((r) => r.names.length > 0);
  });

  constructor() {
    void this.store.refresh();
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
      title: s.gameTitle,
      sessionId: s.sessionId,
      sessionWhen: s.sessionStartsAt ? formatDateTime(s.sessionStartsAt, tz) : null,
      names: open.map((t) => t.nickname),
      closes: closesAt ? formatDeadline(closesAt, tz) : null,
      queryParams: s.sessionId === null ? null : { session: s.sessionId },
    };
  }
}
