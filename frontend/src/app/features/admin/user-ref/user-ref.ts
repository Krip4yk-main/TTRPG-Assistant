import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { ModerationUserRefDto } from '@nri/shared';

/**
 * Людина в адмінці: нік (чи «Видалений користувач») з посиланням на картку й роль персоналу.
 * `null` — текст `emptyKey` (напр. «Система»).
 */
@Component({
  selector: 'nri-admin-user-ref',
  imports: [RouterLink, TranslatePipe],
  templateUrl: './user-ref.html',
  styleUrl: './user-ref.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminUserRef {
  readonly user = input.required<ModerationUserRefDto | null>();
  readonly emptyKey = input('admin.system');
}
