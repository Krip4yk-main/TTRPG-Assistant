import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import {
  isRestrictedGame,
  type ApplicationConstraintDto,
  type ChannelLink,
  type GameDto,
  type GameStatus,
  type GameViewDto,
  type GameViewerDto,
  type PublicGameDto,
  type RestrictedGameDto,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { ApplicationsApi } from '../../../core/applications/applications.api';
import { AuthStore } from '../../../core/auth/auth.store';
import { CatalogStore } from '../../../core/catalog/catalog.store';
import { GamesApi } from '../../../core/games/games.api';
import { SeoService } from '../../../core/seo/seo.service';
import {
  differentZones,
  formatDateTime,
  formatTime,
  viewerTimeZone,
} from '../../../core/i18n/dates';
import { WarningChip } from '../../../shared/warning-chip/warning-chip';
import {
  ConfirmDialog,
  type ConfirmDialogData,
} from '../../../shared/confirm-dialog/confirm-dialog';
import {
  ApplyDialog,
  type ApplyDialogData,
  type ApplyDialogResult,
} from '../../applications/apply-dialog/apply-dialog';
import { LeaveDialog, type LeaveDialogData } from '../../members/leave-dialog/leave-dialog';
import { MembersPanel } from '../../members/members-panel/members-panel';
import {
  ScheduleRuleDialog,
  type ScheduleRuleDialogData,
} from '../../sessions/schedule-rule-dialog/schedule-rule-dialog';
import { SessionsList } from '../../sessions/sessions-list/sessions-list';

const EDITABLE = new Set<GameStatus>(['draft', 'recruiting', 'started']);
const NOINDEX_STATUSES = new Set<GameStatus>(['draft', 'cancelled']);

/** Повідомлення про дію із заявкою: ключ i18n. */
interface Notice {
  kind: 'error' | 'info';
  key: string;
  /** Показати посилання на «Мої заявки». */
  link?: boolean;
}

/** Повна гра для показу; приватні поля — лише для майстра й учасників. */
type FullGame = PublicGameDto & { address?: string | null; channelLinks?: ChannelLink[] };

/**
 * Сторінка гри (`/games/:id`, публічна). Обмежена гра (18+/21+ для гостя чи молодшого) —
 * лише назва, майстер і вікова позначка під блюром; опис та інші поля не рендеряться.
 */
@Component({
  selector: 'nri-game-details',
  imports: [
    RouterLink,
    MatButtonModule,
    MatIconModule,
    TranslatePipe,
    WarningChip,
    MembersPanel,
    SessionsList,
  ],
  templateUrl: './game-details.html',
  styleUrl: './game-details.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameDetails {
  private readonly api = inject(GamesApi);
  private readonly auth = inject(AuthStore);
  private readonly catalog = inject(CatalogStore);
  private readonly seo = inject(SeoService);
  private readonly applications = inject(ApplicationsApi);
  private readonly dialog = inject(MatDialog);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly sessionsList = viewChild(SessionsList);

  /** `:id` з маршруту. */
  readonly id = input.required<string>();

  protected readonly view = signal<GameViewDto | null>(null);
  protected readonly state = signal<'loading' | 'ready' | 'notFound' | 'error'>('loading');
  protected readonly notice = signal<Notice | null>(null);
  /** Іде подання/відкликання заявки — захист від подвійного кліку. */
  protected readonly busy = signal(false);
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

  /** Склад гри бачать майстер (крім чернетки) і активні учасники — як на бекенді. */
  protected readonly showMembers = computed(() => {
    const g = this.game();
    if (!g) return false;
    return this.isGm() ? g.status !== 'draft' : this.relation() === 'member';
  });
  /** Відповіді майстра на обмеження з моєї затвердженої заявки (лише учаснику). */
  protected readonly myConstraints = signal<ApplicationConstraintDto[] | null>(null);
  /** Гра, для якої вже запитано мою заявку (щоб тихе оновлення не повторювало запит). */
  private constraintsFor: number | null = null;

  /** Майстер може виключати й банити, поки гра набирає чи триває. */
  protected readonly manageable = computed(() => {
    const s = this.game()?.status;
    return s === 'recruiting' || s === 'started';
  });

  /** Учасник може вийти, поки гра набирає чи триває (як на бекенді). */
  protected readonly canLeave = computed(
    () => !this.isGm() && this.relation() === 'member' && this.manageable(),
  );

  /** Стосунок глядача до гри (сервер віддає лише автентифікованому). */
  protected readonly relation = computed(() => this.game()?.viewer?.relation ?? null);
  /** Заявки приймаються в `recruiting` і в `started` з `showWhenFull` (як на бекенді). */
  protected readonly accepting = computed(() => {
    const g = this.game();
    return !!g && (g.status === 'recruiting' || (g.status === 'started' && g.showWhenFull));
  });
  /** Чому подати заявку не можна (ключ i18n) або `null`. */
  protected readonly applyBlock = computed<string | null>(() => {
    const rel = this.relation();
    if (rel === 'banned') return 'games.details.bannedHint';
    if (rel === 'blacklisted') return 'games.details.blacklistedHint';
    if (!this.accepting()) return 'games.details.closedHint';
    return null;
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
  /**
   * Найближча сесія — у поясі глядача (як на картці пошуку); назва поясу додається, якщо
   * він відрізняється від поясу гри.
   */
  protected readonly nextSession = computed(() => {
    const g = this.game();
    if (!g?.nextSessionAt) return null;
    const tz = viewerTimeZone(this.auth.me());
    return formatDateTime(g.nextSessionAt, tz, { showZone: differentZones(tz, g.timezone) });
  });
  /**
   * Дні тижня розкладу задані в поясі гри, тож поруч показуємо час сесії в тому ж поясі з
   * явною міткою (`о 19:00 за поясом гри (Europe/Kyiv)`), а не конвертуємо: у поясі
   * глядача сесія може припадати на інший день.
   */
  protected readonly scheduleZone = computed(() => {
    const g = this.game();
    return g ? { time: formatTime(g.startsAt, g.timezone), tz: g.timezone } : null;
  });
  protected readonly durationHours = computed(() => (this.game()?.durationMinutes ?? 0) / 60);
  protected readonly returnTo = computed(() => `/games/${this.id()}`);

  constructor() {
    void this.catalog.load();
    effect(() => {
      const id = Number(this.id());
      void this.load(id);
    });
    // Учасник бачить відповіді майстра на свої обмеження.
    effect(() => {
      const g = this.game();
      const member = !this.isGm() && this.relation() === 'member';
      untracked(() => {
        if (!g || !member) {
          this.myConstraints.set(null);
          this.constraintsFor = null;
        } else if (this.constraintsFor !== g.id) {
          this.constraintsFor = g.id;
          void this.loadMyConstraints(g.id);
        }
      });
    });
  }

  /** Склад чи сесії змінились — тихо оновлюємо вільні місця й найближчу сесію. */
  protected async membersChanged(): Promise<void> {
    await this.load(Number(this.id()), true);
  }

  /** «Вийти з гри»: діалог робить запит сам; після виходу приватне зникає зі сторінки. */
  protected async leave(): Promise<void> {
    const g = this.game();
    if (!g || this.busy() || !this.canLeave()) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      const ref = this.dialog.open<LeaveDialog, LeaveDialogData, boolean>(LeaveDialog, {
        data: { gameId: g.id, title: g.title },
        autoFocus: 'first-tabbable',
        restoreFocus: true,
        width: '560px',
        maxWidth: 'calc(100vw - 32px)',
      });
      if (!(await firstValueFrom(ref.afterClosed()))) return;
      await this.load(g.id, true);
      this.notice.set({ kind: 'info', key: 'games.details.left' });
      this.focusNotice();
    } finally {
      this.busy.set(false);
    }
  }

  /** «Змінити розклад» (кампанія) чи «Перетворити на кампанію» (ваншот). */
  protected async changeRule(mode: ScheduleRuleDialogData['mode']): Promise<void> {
    const g = this.game();
    if (!g || this.busy() || !this.isGm() || !this.manageable()) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      const ref = this.dialog.open<ScheduleRuleDialog, ScheduleRuleDialogData, GameDto>(
        ScheduleRuleDialog,
        {
          data: { game: g, mode },
          autoFocus: 'first-tabbable',
          restoreFocus: true,
          width: '600px',
          maxWidth: 'calc(100vw - 32px)',
        },
      );
      if (!(await firstValueFrom(ref.afterClosed()))) return;
      await this.load(g.id, true);
      await this.sessionsList()?.reload();
      this.notice.set({
        kind: 'info',
        key: mode === 'convert' ? 'games.details.converted' : 'games.details.scheduleChanged',
      });
      this.focusNotice();
    } finally {
      this.busy.set(false);
    }
  }

  protected async retry(): Promise<void> {
    await this.load(Number(this.id()));
  }

  /** Діалог заявки; запит робить сам діалог. */
  protected async apply(): Promise<void> {
    const g = this.game();
    if (!g || this.busy() || this.applyBlock()) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      const data: ApplyDialogData = {
        gameId: g.id,
        title: g.title,
        warningSlugs: this.warningSlugs(),
        customWarnings: g.customWarnings,
        questions: g.applicationQuestions,
      };
      const ref = this.dialog.open<ApplyDialog, ApplyDialogData, ApplyDialogResult>(ApplyDialog, {
        data,
        autoFocus: 'first-tabbable',
        restoreFocus: true,
        width: '640px',
        maxWidth: 'calc(100vw - 32px)',
      });
      const result = await firstValueFrom(ref.afterClosed());
      if (!result) return;
      if (result.status === 'applied') {
        this.setViewer({ relation: 'pending', applicationId: result.application.id });
        this.notice.set({ kind: 'info', key: 'games.details.applied', link: true });
      } else {
        // Заявка вже є (інша вкладка) — беремо актуальний стан із сервера.
        this.notice.set({ kind: 'info', key: 'games.details.alreadyApplied', link: true });
        await this.load(g.id, true);
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** Відкликати власну `pending`-заявку — лише після підтвердження. */
  protected async withdraw(): Promise<void> {
    const id = this.game()?.viewer?.applicationId;
    if (!id || this.busy()) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      const ref = this.dialog.open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
        data: {
          title: 'games.applications.confirmWithdraw.title',
          text: 'games.applications.confirmWithdraw.text',
          confirm: 'games.applications.confirmWithdraw.confirm',
          danger: true,
        },
        autoFocus: 'first-tabbable',
        restoreFocus: true,
      });
      if (!(await firstValueFrom(ref.afterClosed()))) return;
      await firstValueFrom(this.applications.withdraw(id));
      this.setViewer({ relation: 'none', applicationId: null });
      this.notice.set({ kind: 'info', key: 'games.details.withdrawn' });
    } catch (err) {
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') this.notice.set({ kind: 'error', key: `errors.${code}` });
    } finally {
      this.busy.set(false);
    }
  }

  private async loadMyConstraints(gameId: number): Promise<void> {
    try {
      const mine = await firstValueFrom(this.applications.mine());
      if (this.constraintsFor !== gameId) return;
      // Затверджена заявка на цю гру; якщо їх кілька (виключили й прийняли знову) — новіша.
      const approved = mine
        .filter((a) => a.gameId === gameId && a.status === 'approved')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      this.myConstraints.set(approved?.constraints ?? []);
    } catch {
      // Блок необов'язковий: без нього сторінка гри працює.
      this.myConstraints.set(null);
    }
  }

  private focusNotice(): void {
    afterNextRender(
      () => this.host.nativeElement.querySelector<HTMLElement>('.notice-area')?.focus(),
      { injector: this.injector },
    );
  }

  private setViewer(viewer: GameViewerDto): void {
    this.view.update((v) => (v && !isRestrictedGame(v) ? { ...v, viewer } : v));
  }

  /** `silent` — оновити дані без стану «завантаження» (після дії на сторінці). */
  private async load(id: number, silent = false): Promise<void> {
    const seq = ++this.seq;
    if (!silent) {
      this.state.set('loading');
      this.view.set(null);
      this.notice.set(null);
    }
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
