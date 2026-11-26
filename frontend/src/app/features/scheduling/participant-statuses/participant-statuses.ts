import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type {
  CommonTimeStatus,
  CommonTimesParticipantDto,
  OneOffCandidateStatusDto,
  RegularCandidateStatusDto,
} from '@nri/shared';

const ICONS: Record<CommonTimeStatus, string> = {
  can: 'check_circle',
  cannot: 'cancel',
  unknown: 'help',
};

interface Row {
  userId: number;
  nickname: string | null;
  isGm: boolean;
  hasCalendar: boolean;
  status: CommonTimeStatus;
  icon: string;
  weeksCan: number | null;
  outside: number;
}

/**
 * Хто може / не може / невідомо для одного варіанта часу: значок (декоративний) і текст
 * статусу — колір не єдиний носій змісту. Для регулярного варіанта — ще «N з M тижнів» і
 * тижні, зсунуті переходом на літній/зимовий час.
 */
@Component({
  selector: 'nri-participant-statuses',
  imports: [MatIconModule, TranslatePipe],
  templateUrl: './participant-statuses.html',
  styleUrl: './participant-statuses.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ParticipantStatuses {
  readonly participants = input.required<readonly CommonTimesParticipantDto[]>();
  readonly statuses =
    input.required<readonly (OneOffCandidateStatusDto | RegularCandidateStatusDto)[]>();
  /** Сесій регулярного кандидата в горизонті; `null` — разовий варіант. */
  readonly weeks = input<number | null>(null);

  protected readonly rows = computed<Row[]>(() => {
    const byId = new Map(this.participants().map((p) => [p.userId, p]));
    return this.statuses().map((s) => {
      const p = byId.get(s.userId);
      const regular = 'weeksCan' in s ? s : null;
      return {
        userId: s.userId,
        nickname: p?.nickname ?? null,
        isGm: p?.isGm ?? false,
        hasCalendar: p?.hasCalendar ?? false,
        status: s.status,
        icon: ICONS[s.status],
        weeksCan: regular ? regular.weeksCan : null,
        outside: regular?.outsideSlotsWeeks ?? 0,
      };
    });
  });
}
