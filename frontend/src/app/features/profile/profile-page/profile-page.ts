import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type { PublicProfileDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { CatalogStore } from '../../../core/catalog/catalog.store';
import { ProfileApi } from '../../../core/profile/profile.api';
import { SeoService } from '../../../core/seo/seo.service';
import { UserName } from '../../../shared/user-name/user-name';
import { GameCard } from '../../search/game-card/game-card';
import { RatingSummary } from '../../ratings/rating-summary/rating-summary';

/**
 * Публічний профіль (`/users/:publicId`). Приховані власником поля бекенд не надсилає,
 * тож шаблон показує лише присутні ключі. Видалений акаунт — лише «Видалений користувач».
 */
@Component({
  selector: 'nri-profile-page',
  imports: [
    RouterLink,
    MatButtonModule,
    MatIconModule,
    TranslatePipe,
    UserName,
    GameCard,
    RatingSummary,
  ],
  templateUrl: './profile-page.html',
  styleUrl: './profile-page.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfilePage {
  private readonly api = inject(ProfileApi);
  private readonly auth = inject(AuthStore);
  private readonly catalog = inject(CatalogStore);
  private readonly seo = inject(SeoService);
  private readonly translate = inject(TranslateService);

  /** `:publicId` з маршруту. */
  readonly publicId = input.required<string>();

  protected readonly profile = signal<PublicProfileDto | null>(null);
  protected readonly state = signal<'loading' | 'ready' | 'notFound' | 'error'>('loading');
  private seq = 0;

  protected readonly signedIn = this.auth.isAuthenticated;
  protected readonly isMe = computed(() => {
    const p = this.profile();
    return !!p && this.auth.me()?.publicId === p.publicId;
  });
  protected readonly deleted = computed(() => this.profile()?.status === 'deleted');
  protected readonly systems = computed(() => {
    const ids = this.profile()?.favoriteSystemIds;
    if (!ids) return null;
    return ids.map((id) => this.catalog.systemName(id)).filter((n): n is string => !!n);
  });
  protected readonly gamesAsGm = computed(() => this.profile()?.gamesAsGm ?? []);
  protected readonly gamesAsPlayer = computed(() => this.profile()?.gamesAsPlayer ?? []);

  constructor() {
    void this.catalog.load();
    effect(() => {
      const id = this.publicId();
      untracked(() => void this.load(id));
    });
  }

  protected retry(): void {
    void this.load(this.publicId());
  }

  private async load(publicId: string): Promise<void> {
    const seq = ++this.seq;
    this.state.set('loading');
    this.profile.set(null);
    try {
      const p = await firstValueFrom(this.api.getPublic(publicId));
      if (seq !== this.seq) return;
      this.profile.set(p);
      this.state.set('ready');
      this.updateSeo(p);
    } catch (err) {
      if (seq !== this.seq) return;
      const notFound = toApiError(err).status === 404;
      this.state.set(notFound ? 'notFound' : 'error');
      if (notFound) this.seo.set({ titleKey: 'profile.page.notFound', noindex: true });
    }
  }

  private updateSeo(p: PublicProfileDto): void {
    if (p.status === 'deleted') {
      this.seo.set({ titleKey: 'user.deleted', noindex: true });
      return;
    }
    const name = p.nickname || this.translate.instant('user.noNickname');
    this.seo.set({
      title: name,
      description:
        p.bio || (this.translate.instant('profile.page.seoDescription', { name }) as string),
      image: p.avatarUrl,
      // Акаунт без завершеної реєстрації не індексується.
      noindex: p.status !== 'active',
    });
  }
}
