import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
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
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  isRestrictedGame,
  windowEnd,
  type ApplicationConstraintDto,
  type GameChangeScope,
  type GameDto,
  type GameStatus,
  type GameTransitionDto,
  type GameViewDto,
  type GameViewerDto,
  type PublicGameDto,
  type RestrictedGameDto,
  type Weekday,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { ApplicationsApi } from '../../../core/applications/applications.api';
import { AuthStore } from '../../../core/auth/auth.store';
import { CatalogStore } from '../../../core/catalog/catalog.store';
import { GamesApi } from '../../../core/games/games.api';
import { RatingsApi } from '../../../core/ratings/ratings.api';
import { SeoService } from '../../../core/seo/seo.service';
import {
  formatDateTime,
  formatTime,
  formatWindow,
  viewerTimeZone,
  weeklyInZone,
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
import { PollsPanel, type PollsPanelHandle } from '../../scheduling/polls-panel/polls-panel';
import { openPauseDialog, openResumeDialog, resumedNoticeKey } from '../pause/pause-flow';
import { PausePanel, type PauseAction } from '../pause/pause-panel';
import { CalendarPin } from '../../calendar/calendar-pin/calendar-pin';
import { NoteEditor } from '../../notes/note-editor/note-editor';
import { SharedPlayerNotes } from '../../notes/shared-player-notes/shared-player-notes';
import { NotesApi } from '../../../core/notes/notes.api';
import { ChangeWatcher, type ChangeHandle } from '../../../core/realtime/change-watcher';
import { HIGHLIGHT_MS } from '../../../core/realtime/highlight';
import { UpdateBanner } from '../../../shared/update-banner/update-banner';
import { GmRating } from '../../ratings/gm-rating/gm-rating';
import { BlockedBadge } from '../../../shared/blocked-badge/blocked-badge';
import {
  ComplaintDialog,
  type ComplaintDialogData,
} from '../../moderation/complaint-dialog/complaint-dialog';

const EDITABLE = new Set<GameStatus>(['draft', 'recruiting', 'started', 'paused']);
const NOINDEX_STATUSES = new Set<GameStatus>(['draft', 'cancelled', 'paused']);
/** Дії майстра з паузи, які можна відкрити посиланням (`?action=…`, з нагадування). */
const PAUSE_LINK_ACTIONS: readonly PauseAction[] = ['resume', 'recruit', 'finish'];

/** Повідомлення про дію із заявкою: ключ i18n. */
interface Notice {
  kind: 'error' | 'info';
  key: string;
  /** Показати посилання на «Мої заявки». */
  link?: boolean;
  /** Не озвучувати (те саме вже озвучено інакше, напр. на старті ефекту заявки). */
  silent?: boolean;
}

/** Повна гра для показу; приватні поля — лише для майстра й учасників. */
type FullGame = PublicGameDto &
  Partial<Pick<GameDto, 'address' | 'channelLinks' | 'pauseReason' | 'pauseNote'>>;

/**
 * Сторінка гри (`/games/:id`, публічна). Обмежена гра (16+/18+/21+ для гостя чи молодшого) —
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
    CalendarPin,
    NoteEditor,
    SharedPlayerNotes,
    UpdateBanner,
    GmRating,
    BlockedBadge,
    PausePanel,
    PollsPanel,
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
  private readonly ratings = inject(RatingsApi);
  private readonly dialog = inject(MatDialog);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly notes = inject(NotesApi);
  private readonly router = inject(Router);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly translate = inject(TranslateService);
  private readonly sessionsList = viewChild(SessionsList);
  private readonly membersPanel = viewChild(MembersPanel);
  /** Панель «Спільний час» вантажиться відкладено (@defer) — без посилання на клас. */
  private readonly pollsPanel = viewChild<PollsPanelHandle>('polls');
  private readonly watcher = inject(ChangeWatcher);
  /** Підписка на кімнати поточної гри (лише автентифікованим). */
  private readonly watch = signal<ChangeHandle | null>(null);
  /** Банер «Є оновлення» — є пінги, які сторінка ще не перечитала. */
  protected readonly hasUpdates = computed(() => (this.watch()?.pending().size ?? 0) > 0);
  protected readonly refreshing = signal(false);
  /** Підсвітити шапку гри після оновлення деталей. */
  protected readonly flashDetails = signal(false);
  private flashTimer: ReturnType<typeof setTimeout> | null = null;

  /** `:id` з маршруту. */
  readonly id = input.required<string>();
  /**
   * `?action=resume|recruit|finish` — відкрити діалог майстра для кампейну на паузі (посилання
   * з нагадування про довгу паузу). Після відкриття параметр прибирається з адреси.
   */
  readonly action = input<string | undefined>();
  private actionHandled: string | null = null;
  /** `?poll=` — голосування зі сповіщення (фокус на ньому). */
  readonly poll = input<string | undefined>();
  /** `?session=` — майстру альтернативи сесії (сповіщення «не буду»). */
  readonly session = input<string | undefined>();

  protected readonly view = signal<GameViewDto | null>(null);
  /** Обкладинка, що не завантажилась (битий URL): ховаємо, як гру без обкладинки. */
  protected readonly brokenCover = signal<string | null>(null);
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
  /** «Поскаржитися» на гру — будь-якому активному глядачеві, крім її майстра. */
  protected readonly canComplain = computed(
    () => this.auth.isActive() && !!this.view() && !this.isGm(),
  );
  /** Копію можна зробити з будь-якої власної гри, крім закритої адміністрацією. */
  protected readonly canClone = computed(() => {
    const g = this.game();
    return this.isGm() && !!g && !g.closedByAdmin;
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
  /** Приватна нотатка на гру (майстру й учасникам). */
  protected readonly privateNote = computed(() => {
    const id = this.game()?.id;
    return id ? this.notes.gamePrivate(id) : null;
  });
  /** Відповіді майстра на обмеження з моєї затвердженої заявки (лише учаснику). */
  protected readonly myConstraints = signal<ApplicationConstraintDto[] | null>(null);
  /**
   * Є відкриті підсумкові чи «вихідні» оцінки (кінець гри, хтось вийшов) — кнопка
   * «Оцінити учасників». Запит лише майстру, учасникам і колишнім учасникам.
   */
  protected readonly canRateMembers = signal(false);
  private ratingKey: string | null = null;
  /** Гра, для якої вже запитано мою заявку (щоб тихе оновлення не повторювало запит). */
  private constraintsFor: number | null = null;

  /** Майстер може виключати й банити, поки гра набирає чи триває. */
  protected readonly manageable = computed(() => {
    const s = this.game()?.status;
    return s === 'recruiting' || s === 'started';
  });

  /** Склад (вихід, виключення, бан) змінюється й під час паузи (як на бекенді). */
  protected readonly membersManageable = computed(
    () => this.manageable() || this.game()?.status === 'paused',
  );

  /** Учасник може вийти, поки гра набирає, триває чи на паузі (як на бекенді). */
  protected readonly canLeave = computed(
    () => !this.isGm() && this.relation() === 'member' && this.membersManageable(),
  );

  protected readonly paused = computed(() => this.game()?.status === 'paused');
  /** «Створити копію»: нова чернетка майстра → одразу її форма редагування. */
  protected async clone(): Promise<void> {
    const g = this.game();
    if (!g || this.busy() || !this.canClone()) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      const copy = await firstValueFrom(this.api.clone(g.id));
      void this.announcer.announce(this.translate.instant('games.details.cloned'), 'polite');
      await this.router.navigate(['/games', copy.id, 'edit']);
    } catch (err) {
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') {
        this.notice.set({ kind: 'error', key: `errors.${code}` });
        this.focusNotice();
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** «Поставити на паузу» — лише майстру кампейну, що набирає чи триває. */
  protected readonly canPause = computed(
    () => this.isGm() && this.game()?.kind === 'campaign' && this.manageable(),
  );
  /** Панель «Кампейн на паузі»: з якого моменту (у поясі глядача, без назви поясу) і причина. */
  protected readonly pauseInfo = computed(() => {
    const g = this.game();
    if (!g || g.status !== 'paused') return null;
    return {
      since: g.pausedAt ? formatDateTime(g.pausedAt, viewerTimeZone(this.auth.me())) : null,
      reasonKey: g.pauseReason ? `games.pause.reasons.${g.pauseReason}` : null,
      note: g.pauseNote ?? null,
    };
  });

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
    if (this.paused()) return 'games.details.pausedHint';
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
   * Найближча сесія має приблизний час правила: гра з вікном початку, а сесія — у час правила
   * (місцевий час доби збігається з першою сесією; перенесена на інший час — уже не за
   * правилом). Вікна самої сесії у відповіді гри немає — точно його показує список сесій.
   */
  protected readonly nextSessionApprox = computed(() => {
    const g = this.game();
    if (!g?.nextSessionAt || !g.startsAt || g.startWindowMinutes === null) return false;
    return formatTime(g.nextSessionAt, g.timezone) === formatTime(g.startsAt, g.timezone);
  });
  /** Найближча сесія — у поясі глядача, без назви поясу (як на картці пошуку). */
  protected readonly nextSession = computed(() => {
    const g = this.game();
    if (!g?.nextSessionAt) return null;
    const window = this.nextSessionApprox() ? g.startWindowMinutes : null;
    return formatWindow(g.nextSessionAt, window, viewerTimeZone(this.auth.me()));
  });
  /** Підпис, коли найближчої сесії немає: чернетка без дати — «Дату ще не визначено». */
  protected readonly noNextKey = computed(() =>
    this.game()?.startsAt === null ? 'games.my.noStartDate' : 'search.card.noNext',
  );
  /**
   * Тижневий розклад (дні й час) — теж у поясі глядача: дні задані в поясі гри й
   * переводяться кожен окремо (сесія може припасти на сусідній день).
   */
  protected readonly schedule = computed(
    (): { weekdays: Weekday[]; time: string | null; end: string | null } | null => {
      const g = this.game();
      if (!g) return null;
      // Без дати старту (чернетка) часу ще немає — лише дні тижня в поясі гри.
      if (g.startsAt === null) return { weekdays: [...g.weekdays], time: null, end: null };
      const viewer = viewerTimeZone(this.auth.me());
      const weekly = weeklyInZone(g.startsAt, g.timezone, g.weekdays, viewer);
      // Вікно початку: кінець — той самий розрахунок від кінця вікна першої сесії.
      const end = g.startWindowMinutes
        ? weeklyInZone(
            windowEnd(new Date(g.startsAt), g.startWindowMinutes).toISOString(),
            g.timezone,
            g.weekdays,
            viewer,
          ).time
        : null;
      return { ...weekly, end };
    },
  );
  protected readonly durationHours = computed(() => (this.game()?.durationMinutes ?? 0) / 60);
  protected readonly returnTo = computed(() => `/games/${this.id()}`);

  constructor() {
    void this.catalog.load();
    effect(() => {
      const id = Number(this.id());
      void this.load(id);
    });
    // Кімнати гри: підписка на вході на сторінку, відписка на виході чи зміні гри.
    effect((onCleanup) => {
      const id = Number(this.id());
      if (!this.signedIn() || !Number.isInteger(id) || id <= 0) return;
      const handle = untracked(() =>
        this.watcher.open({
          gameId: id,
          watch: true,
          scopes: ['details', 'sessions', 'members', 'polls'],
        }),
      );
      this.watch.set(handle);
      onCleanup(() => {
        handle.stop();
        this.watch.set(null);
      });
    });
    // Стосунок глядача змінився (вступ, вихід, виключення) — сервер переоцінює кімнати.
    let relationKey: string | null = null;
    effect(() => {
      const key = `${this.game()?.id ?? ''}:${this.relation() ?? ''}:${this.isGm()}`;
      const handle = untracked(() => this.watch());
      if (relationKey !== null && key !== relationKey) handle?.rewatch();
      relationKey = key;
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.flashTimer) clearTimeout(this.flashTimer);
    });
    effect(() => {
      const g = this.game();
      const involved = this.isGm() || this.relation() === 'member' || g?.viewer?.wasMember === true;
      const key = g && involved && g.status !== 'draft' ? `${g.id}:${g.status}` : null;
      untracked(() => {
        if (key === this.ratingKey) return;
        this.ratingKey = key;
        this.canRateMembers.set(false);
        if (key) void this.loadRatingTargets(g!.id, key);
      });
    });
    // `?action=…` з нагадування про довгу паузу — відкриваємо діалог майстру один раз на
    // перехід; параметр прибираємо, тож повторне посилання на тій самій сторінці спрацює знову.
    // Кампейн уже не на паузі — коротке пояснення замість мовчання.
    effect(() => {
      const action = this.action();
      const g = this.game();
      if (!action) {
        this.actionHandled = null;
        return;
      }
      if (!g || !this.isGm()) return;
      const key = `${g.id}:${action}`;
      if (key === this.actionHandled) return;
      this.actionHandled = key;
      if (!(PAUSE_LINK_ACTIONS as readonly string[]).includes(action)) return;
      untracked(() => {
        void this.router.navigate([], {
          queryParams: { action: null },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        });
        if (g.status === 'paused') {
          void this.runPauseAction(action as PauseAction);
        } else {
          this.notice.set({ kind: 'info', key: 'games.pause.linkStale' });
          this.focusNotice();
        }
      });
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
    this.quiet();
    await this.load(Number(this.id()), true);
    this.refreshRatingTargets();
  }

  /** Голосування застосовано чи сесію перенесено з панелі «Спільний час». */
  protected async scheduleChanged(): Promise<void> {
    this.quiet();
    await this.load(Number(this.id()), true);
    await this.sessionsList()?.reload();
  }

  /** Склад змінився (вихід, виключення) — могли з'явитися «вихідні» оцінки. */
  private refreshRatingTargets(): void {
    const g = this.game();
    const key = this.ratingKey;
    if (g && key) void this.loadRatingTargets(g.id, key);
  }

  /** Власна дія глядача: її ж пінги не мають піднімати банер. */
  protected quiet(scopes?: GameChangeScope[]): void {
    this.watch()?.quiet(scopes);
  }

  /**
   * «Оновити» на банері: перечитати лише змінені частини й підсвітити те, що змінилось.
   * Деталі перечитуються завжди: склад і сесії впливають на вільні місця й найближчу сесію.
   */
  protected async refreshUpdates(): Promise<void> {
    const handle = this.watch();
    if (!handle || this.refreshing()) return;
    const scopes = handle.take();
    this.refreshing.set(true);
    try {
      const before = this.game();
      const ok = await this.load(Number(this.id()), true);
      const after = this.game();
      const failed: GameChangeScope[] = ok ? [] : ['details'];
      if (scopes.has('details') && before && after) {
        // Стосунок глядача й позначка перегляду — не зміни гри.
        const print = (g: FullGame) => JSON.stringify({ ...g, viewer: null, seen: null });
        if (print(before) !== print(after)) this.flashHead();
      }
      const [sessionsOk, membersOk, pollsOk] = await Promise.all([
        scopes.has('sessions') ? this.sessionsList()?.reload(true) : true,
        scopes.has('members') ? this.membersPanel()?.reload(true) : true,
        scopes.has('polls') ? this.pollsPanel()?.reload(true) : true,
      ]);
      if (sessionsOk === false) failed.push('sessions');
      if (membersOk === false) failed.push('members');
      if (pollsOk === false) failed.push('polls');
      if (scopes.has('members')) this.refreshRatingTargets();
      // Не вдалося перечитати — області повертаються, банер лишається.
      handle.restore(failed.filter((s) => scopes.has(s)));
    } finally {
      this.refreshing.set(false);
    }
    // Кнопка банера зникла — фокус на заголовок гри, а не в нікуди.
    afterNextRender(
      () => this.host.nativeElement.querySelector<HTMLElement>('.game h1, h1')?.focus(),
      { injector: this.injector },
    );
  }

  private flashHead(): void {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashDetails.set(true);
    this.flashTimer = setTimeout(() => this.flashDetails.set(false), HIGHLIGHT_MS);
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
      this.quiet();
      await this.load(g.id, true);
      this.refreshRatingTargets();
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
      this.quiet();
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

  /** «Поставити на паузу»: діалог причини; після паузи — перечитати гру й сесії. */
  protected async pause(): Promise<void> {
    const g = this.game();
    if (!g || this.busy() || !this.canPause()) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      const dto = await openPauseDialog(this.dialog, {
        gameId: g.id,
        title: g.title,
        beforeRequest: () => this.quiet(),
      });
      if (!dto) return;
      await this.afterPauseChange(g.id, 'games.pause.done.pause');
    } finally {
      this.busy.set(false);
    }
  }

  /** Дія з панелі паузи: «Відновити», «Оголосити донабір», «Завершити кампейн» чи «Скасувати гру». */
  protected async runPauseAction(action: PauseAction): Promise<void> {
    if (action === 'finish' || action === 'cancel') await this.closePaused(action);
    else await this.resume(action === 'recruit');
  }

  /** «Відновити» / «Оголосити донабір»: діалог дати першої сесії. */
  protected async resume(recruit: boolean): Promise<void> {
    const g = this.game();
    if (!g || this.busy() || !this.isGm() || g.status !== 'paused') return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      const dto: GameTransitionDto | null = await openResumeDialog(this.dialog, {
        game: g,
        recruit,
        firstStart: g.startedAt === null,
        viewerTimezone: viewerTimeZone(this.auth.me()),
        beforeRequest: () => this.quiet(),
      });
      if (!dto) return;
      await this.afterPauseChange(g.id, resumedNoticeKey(dto, recruit));
    } finally {
      this.busy.set(false);
    }
  }

  /** «Завершити кампейн» / «Скасувати гру» з паузи — після того самого підтвердження, що й деінде. */
  private async closePaused(action: 'finish' | 'cancel'): Promise<void> {
    const g = this.game();
    if (!g || this.busy() || !this.isGm() || g.status !== 'paused') return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      const ref = this.dialog.open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
        data: {
          title: `games.confirm.${action}.title`,
          text: `games.confirm.${action}.text`,
          confirm: `games.confirm.${action}.confirm`,
          danger: true,
        },
        autoFocus: 'first-tabbable',
        restoreFocus: true,
      });
      if (!(await firstValueFrom(ref.afterClosed()))) return;
      this.quiet();
      await firstValueFrom(this.api.transition(g.id, action));
      await this.afterPauseChange(g.id, `games.my.done.${action}`);
    } catch (err) {
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') {
        this.notice.set({ kind: 'error', key: `errors.${code}` });
        this.focusNotice();
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** Після паузи, відновлення чи завершення: свої пінги тихі, гра й сесії — із сервера. */
  private async afterPauseChange(id: number, key: string): Promise<void> {
    this.quiet();
    await this.load(id, true);
    await this.sessionsList()?.reload();
    this.notice.set({ kind: 'info', key });
    this.focusNotice();
  }

  /** Діалог скарги на гру; після надсилання — повідомлення на сторінці. */
  protected async complain(g: { id: number; title: string }): Promise<void> {
    if (this.busy() || !this.canComplain()) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      const ref = this.dialog.open<ComplaintDialog, ComplaintDialogData, boolean>(ComplaintDialog, {
        data: { kind: 'game', gameId: g.id, name: g.title },
        autoFocus: 'first-tabbable',
        restoreFocus: true,
        width: '560px',
        maxWidth: 'calc(100vw - 32px)',
      });
      if (!(await firstValueFrom(ref.afterClosed()))) return;
      this.notice.set({ kind: 'info', key: 'moderation.complain.sent' });
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
      this.quiet();
      if (result.status === 'applied') {
        this.setViewer({ relation: 'pending', applicationId: result.application.id });
        this.notice.set({
          kind: 'info',
          key: 'games.details.applied',
          link: true,
          silent: result.announced,
        });
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
      this.quiet();
      this.setViewer({ relation: 'none', applicationId: null });
      this.notice.set({ kind: 'info', key: 'games.details.withdrawn' });
    } catch (err) {
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') this.notice.set({ kind: 'error', key: `errors.${code}` });
    } finally {
      this.busy.set(false);
    }
  }

  private async loadRatingTargets(gameId: number, key: string): Promise<void> {
    try {
      const set = await firstValueFrom(this.ratings.targets(gameId));
      if (this.ratingKey !== key) return;
      this.canRateMembers.set(set.targets.some((t) => t.state === 'open'));
    } catch {
      // Кнопка необов'язкова: без неї оцінити можна зі сповіщення чи сторінки «Оцінити».
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
  private async load(id: number, silent = false): Promise<boolean> {
    const seq = ++this.seq;
    if (!silent) {
      this.state.set('loading');
      this.view.set(null);
      this.notice.set(null);
    }
    if (!Number.isInteger(id) || id <= 0) {
      this.state.set('notFound');
      return false;
    }
    try {
      const g = await firstValueFrom(this.api.get(id));
      if (seq !== this.seq) return true;
      this.view.set(g);
      this.state.set('ready');
      this.updateSeo(g);
      return true;
    } catch (err) {
      if (seq !== this.seq) return true;
      const notFound = toApiError(err).status === 404;
      this.state.set(notFound ? 'notFound' : 'error');
      if (notFound) this.seo.set({ titleKey: 'games.details.notFound', noindex: true });
      return false;
    }
  }

  /** Назва гри у вкладці й превʼю; 16+/18+/21+, чернетки й скасовані — без індексації. */
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
