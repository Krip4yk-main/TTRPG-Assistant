import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { isRestrictedGame, type RestrictedGameDto, type SearchGameCardDto } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { CatalogStore } from '../../../core/catalog/catalog.store';
import { differentZones, formatDateTime, viewerTimeZone } from '../../../core/i18n/dates';

/**
 * Картка гри в пошуку. Для `RestrictedGameDto` — лише назва, майстер і вікова позначка
 * під блюром; інші поля не потрапляють у шаблон, навіть якщо випадково є в об'єкті.
 */
@Component({
  selector: 'nri-game-card',
  imports: [RouterLink, MatIconModule, TranslatePipe],
  templateUrl: './game-card.html',
  styleUrl: './game-card.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameCard {
  private readonly auth = inject(AuthStore);
  private readonly catalog = inject(CatalogStore);

  readonly game = input.required<SearchGameCardDto | RestrictedGameDto>();
  /** Гість бачить на обмеженій картці заклик увійти. */
  readonly guest = input(false);

  /** Обмежена картка: лише дозволені ключі. */
  protected readonly restricted = computed<RestrictedGameDto | null>(() => {
    const g = this.game();
    if (!isRestrictedGame(g)) return null;
    return { id: g.id, title: g.title, gm: g.gm, ageRating: g.ageRating, restricted: true };
  });
  protected readonly full = computed<SearchGameCardDto | null>(() => {
    const g = this.game();
    return isRestrictedGame(g) ? null : g;
  });

  protected readonly systemName = computed(() => {
    const g = this.full();
    return g ? (g.system?.name ?? g.systemOther ?? '') : '';
  });
  protected readonly genreKey = computed(() => {
    const g = this.full();
    return g ? this.catalog.genreKey(g.genreId) : null;
  });
  /** Час — у поясі глядача; назва поясу додається, якщо він відрізняється від поясу гри. */
  protected readonly nextSession = computed(() => {
    const g = this.full();
    if (!g?.nextSessionAt) return null;
    const tz = viewerTimeZone(this.auth.me());
    return formatDateTime(g.nextSessionAt, tz, { showZone: differentZones(tz, g.timezone) });
  });
  protected readonly returnTo = computed(() => `/games/${this.game().id}`);
}
