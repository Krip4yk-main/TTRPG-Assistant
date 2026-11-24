import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import {
  isRestrictedGame,
  type ChannelLink,
  type GameStatus,
  type GameViewDto,
  type PublicGameDto,
  type RestrictedGameDto,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { CatalogStore } from '../../../core/catalog/catalog.store';
import { GamesApi } from '../../../core/games/games.api';
import { SeoService } from '../../../core/seo/seo.service';
import { formatDateTime } from '../../../core/i18n/dates';
import { WarningChip } from '../../../shared/warning-chip/warning-chip';

const EDITABLE = new Set<GameStatus>(['draft', 'recruiting', 'started']);
const NOINDEX_STATUSES = new Set<GameStatus>(['draft', 'cancelled']);

/** Повна гра для показу; приватні поля — лише для майстра й учасників. */
type FullGame = PublicGameDto & { address?: string | null; channelLinks?: ChannelLink[] };

/**
 * Сторінка гри (`/games/:id`, публічна). Обмежена гра (18+/21+ для гостя чи молодшого) —
 * лише назва, майстер і вікова позначка під блюром; опис та інші поля не рендеряться.
 */
@Component({
  selector: 'nri-game-details',
  imports: [RouterLink, MatButtonModule, MatIconModule, TranslatePipe, WarningChip],
  templateUrl: './game-details.html',
  styleUrl: './game-details.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameDetails {
  private readonly api = inject(GamesApi);
  private readonly auth = inject(AuthStore);
  private readonly catalog = inject(CatalogStore);
  private readonly seo = inject(SeoService);

  /** `:id` з маршруту. */
  readonly id = input.required<string>();

  protected readonly view = signal<GameViewDto | null>(null);
  protected readonly state = signal<'loading' | 'ready' | 'notFound' | 'error'>('loading');
  private seq = 0;

  protected readonly signedIn = this.auth.isAuthenticated;

  protected readonly restricted = computed<RestrictedGameDto | null>(() => {
    const g = this.view();
    if (!g || !isRestrictedGame(g)) return null;
    return { id: g.id, title: g.title, gm: g.gm, ageRating: g.ageRating, restricted: true };
  });
  protected readonly game = computed<FullGame | null>(() => {
    const g = this.view();
    return g && !isRestrictedGame(g) ? g : null;
  });

  protected readonly isGm = computed(() => {
    const g = this.view();
    const me = this.auth.me();
    return !!g && !!me && g.gm.publicId === me.publicId;
  });
  protected readonly canEdit = computed(() => {
    const g = this.game();
    return this.isGm() && !!g && EDITABLE.has(g.status);
  });

  protected readonly systemName = computed(() => {
    const g = this.game();
    return g ? (g.system?.name ?? g.systemOther ?? '') : '';
  });
  protected readonly genreKey = computed(() => {
    const g = this.game();
    return g ? this.catalog.genreKey(g.genreId) : null;
  });
  /** Слаги каталожних попереджень (невідомі id пропускаються). */
  protected readonly warningSlugs = computed(() => {
    const g = this.game();
    const list = this.catalog.catalog()?.contentWarnings ?? [];
    if (!g) return [];
    return g.contentWarningIds
      .map((id) => list.find((w) => w.id === id)?.slug)
      .filter((s): s is string => !!s);
  });
  protected readonly nextSession = computed(() => {
    const at = this.game()?.nextSessionAt;
    return at ? formatDateTime(at, this.auth.me()?.timezone ?? this.game()?.timezone) : null;
  });
  protected readonly durationHours = computed(() => (this.game()?.durationMinutes ?? 0) / 60);
  protected readonly returnTo = computed(() => `/games/${this.id()}`);

  constructor() {
    void this.catalog.load();
    effect(() => {
      const id = Number(this.id());
      void this.load(id);
    });
  }

  protected async retry(): Promise<void> {
    await this.load(Number(this.id()));
  }

  private async load(id: number): Promise<void> {
    const seq = ++this.seq;
    this.state.set('loading');
    this.view.set(null);
    if (!Number.isInteger(id) || id <= 0) {
      this.state.set('notFound');
      return;
    }
    try {
      const g = await firstValueFrom(this.api.get(id));
      if (seq !== this.seq) return;
      this.view.set(g);
      this.state.set('ready');
      this.updateSeo(g);
    } catch (err) {
      if (seq !== this.seq) return;
      const notFound = toApiError(err).status === 404;
      this.state.set(notFound ? 'notFound' : 'error');
      if (notFound) this.seo.set({ titleKey: 'games.details.notFound', noindex: true });
    }
  }

  /** Назва гри у вкладці й превʼю; 18+/21+, чернетки й скасовані — без індексації. */
  private updateSeo(g: GameViewDto): void {
    if (isRestrictedGame(g)) {
      this.seo.set({ title: g.title, noindex: true });
      return;
    }
    this.seo.set({
      title: g.title,
      description: g.description,
      image: g.coverUrl,
      noindex: g.ageRating !== 'none' || NOINDEX_STATUSES.has(g.status),
    });
  }
}
