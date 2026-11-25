import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { SanctionActiveDetails } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { formatDateTime, viewerTimeZone } from '../../../core/i18n/dates';

/**
 * Пояснення відмови 409 `SANCTION_ACTIVE`: що саме заборонено, до коли (чи безстроково) і
 * посилання на «Обмеження акаунта» (`link = false` — без нього, напр. у діалозі).
 */
@Component({
  selector: 'nri-sanction-active-notice',
  imports: [RouterLink, TranslatePipe],
  templateUrl: './sanction-active-notice.html',
  styleUrl: './sanction-active-notice.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SanctionActiveNotice {
  private readonly auth = inject(AuthStore);

  readonly details = input.required<SanctionActiveDetails>();
  readonly link = input(true);

  protected readonly textKey = computed(() => {
    const t = this.details().type;
    return t === 'application_limit' || t === 'no_paid_apply' || t === 'no_paid_create'
      ? `moderation.sanctionActive.${t}`
      : 'moderation.sanctionActive.other';
  });
  protected readonly until = computed(() => {
    const end = this.details().endsAt;
    return end ? formatDateTime(end, viewerTimeZone(this.auth.me())) : null;
  });
}
