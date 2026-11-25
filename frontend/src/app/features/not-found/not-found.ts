import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';

/**
 * Сторінка 404 (маршрут `**`): неіснуюча адреса більше не переадресовує на головну. У дизайні
 * «Дошка оголошень» — приколоте рване оголошення на стіні; в інших — звичайна картка.
 * `noindex` — з `data.noindex` маршруту (ставить TitleStrategy на кожній навігації).
 */
@Component({
  selector: 'nri-not-found',
  imports: [MatButtonModule, RouterLink, TranslatePipe],
  templateUrl: './not-found.html',
  styleUrl: './not-found.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotFound {}
