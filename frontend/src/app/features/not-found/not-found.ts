import { ChangeDetectionStrategy, Component, afterNextRender, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { SeoService } from '../../core/seo/seo.service';

/**
 * Сторінка 404 (маршрут `**`): неіснуюча адреса більше не переадресовує на головну. У дизайні
 * «Дошка оголошень» — приколоте рване оголошення на стіні; в інших — звичайна картка.
 */
@Component({
  selector: 'nri-not-found',
  imports: [MatButtonModule, RouterLink, TranslatePipe],
  templateUrl: './not-found.html',
  styleUrl: './not-found.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotFound {
  private readonly seo = inject(SeoService);

  constructor() {
    // Після рендеру — коли TitleStrategy уже скинула метадані навігації.
    afterNextRender(() => this.seo.set({ titleKey: 'titles.notFound', noindex: true }));
  }
}
