import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { NOTIFICATION_NEW_EVENT } from '@nri/shared';
import { filter, merge } from 'rxjs';
import { PendingRatingsStore } from '../../../core/ratings/pending-ratings.store';
import { SocketService } from '../../../core/realtime/socket.service';

/**
 * Посилання «Оцінити» в шапці з кількістю відкритих цілей; видно лише, коли є кого оцінити.
 * Список перечитується після кожного переходу між сторінками, нового сповіщення
 * (запрошення оцінити приходять сповіщеннями) і перепідключення сокета.
 */
@Component({
  selector: 'nri-rate-link',
  imports: [RouterLink, RouterLinkActive, MatButtonModule, MatIconModule, TranslatePipe],
  templateUrl: './rate-link.html',
  styleUrl: './rate-link.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RateLink {
  private readonly store = inject(PendingRatingsStore);
  protected readonly count = this.store.openCount;

  constructor() {
    const socket = inject(SocketService);
    merge(
      inject(Router).events.pipe(filter((e) => e instanceof NavigationEnd)),
      socket.on(NOTIFICATION_NEW_EVENT),
      socket.connected$,
    )
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.store.refresh());
  }
}
