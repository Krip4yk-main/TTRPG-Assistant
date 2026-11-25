import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import type { ModerationLogDto } from '@nri/shared';
import { AdminApi } from '../../../core/moderation/admin.api';
import { AdminDatePipe } from '../admin-date.pipe';
import { Paged } from '../paged';
import { AdminPager } from '../pager/pager';
import { AdminUserRef } from '../user-ref/user-ref';

/** Дії з перекладеною назвою; інші показуються як є (код дії). */
const KNOWN_ACTIONS = new Set([
  'sanction.impose',
  'sanction.lift',
  'sanction.expire',
  'complaint.dismiss',
  'complaint.action',
  'appeal.accept',
  'appeal.reject',
  'rating.hide_text',
  'rating.cancel',
  'role.change',
  'owner.transfer',
  'game.close',
  'game.dismiss_dead',
  'game.dismiss_suspicious',
  'catalog.system_create',
  'catalog.system_update',
]);

/** Типи об'єктів журналу з перекладеною назвою; інші показуються як є. */
const KNOWN_TARGET_TYPES = new Set([
  'user',
  'game',
  'game_system',
  'complaint',
  'appeal',
  'rating',
]);

/**
 * Журнал дій адміністрації (адмін і власник): хто, що, над ким/чим, коли й чому; новіші
 * першими, «Завантажити ще» — курсором.
 */
@Component({
  selector: 'nri-admin-log',
  imports: [TranslatePipe, AdminDatePipe, AdminPager, AdminUserRef],
  templateUrl: './log.html',
  styleUrls: ['../admin-list.less', './log.less'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminLog {
  private readonly api = inject(AdminApi);

  protected readonly list = new Paged<ModerationLogDto>((cursor) => this.api.log(cursor));

  constructor() {
    void this.list.reload();
  }

  /** Ключ i18n типу об'єкта; невідомий тип — сам код (переклад його не знайде й покаже як є). */
  protected targetTypeLabel(type: string): string {
    return KNOWN_TARGET_TYPES.has(type) ? `admin.log.targetTypes.${type}` : type;
  }

  /** Ключ i18n назви дії або `null` (невідома — показати код). */
  protected actionKey(action: string): string | null {
    return KNOWN_ACTIONS.has(action) ? `admin.log.actions.${action.replace('.', '_')}` : null;
  }
}
