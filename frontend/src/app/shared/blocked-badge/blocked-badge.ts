import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

/** Позначка «Акаунт заблоковано» біля імені глобально заблокованого користувача. */
@Component({
  selector: 'nri-blocked-badge',
  imports: [TranslatePipe],
  templateUrl: './blocked-badge.html',
  styleUrl: './blocked-badge.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BlockedBadge {}
