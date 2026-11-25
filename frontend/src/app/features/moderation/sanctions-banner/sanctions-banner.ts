import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { NOTIFICATION_NEW_EVENT } from '@nri/shared';
import { merge } from 'rxjs';
import { MySanctionsStore } from '../../../core/moderation/my-sanctions.store';
import { SocketService } from '../../../core/realtime/socket.service';

/**
 * Банер під шапкою, поки на акаунт накладено чинні санкції; веде на «Обмеження акаунта».
 * Список перечитується на нове сповіщення (накладення, зняття, рішення апеляції приходять
 * сповіщеннями) і на перепідключення сокета.
 */
@Component({
  selector: 'nri-sanctions-banner',
  imports: [RouterLink, MatIconModule, TranslatePipe],
  templateUrl: './sanctions-banner.html',
  styleUrl: './sanctions-banner.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SanctionsBanner {
  private readonly store = inject(MySanctionsStore);
  protected readonly active = this.store.hasActive;

  constructor() {
    const socket = inject(SocketService);
    merge(socket.on(NOTIFICATION_NEW_EVENT), socket.connected$)
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.store.refresh());
  }
}
