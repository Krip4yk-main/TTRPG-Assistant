import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { GameDto, GameStatus, PollDto, SessionDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { viewerTimeZone } from '../../../core/i18n/dates';
import { changedKeys, Highlighter } from '../../../core/realtime/highlight';
import { SchedulingApi } from '../../../core/scheduling/scheduling.api';
import {
  ScheduleRuleDialog,
  type ScheduleRuleDialogData,
} from '../../sessions/schedule-rule-dialog/schedule-rule-dialog';
import {
  CommonTimesDialog,
  type CommonTimesDialogData,
  type CommonTimesDialogResult,
} from '../common-times-dialog/common-times-dialog';
import { PollCard } from '../poll-card/poll-card';
import {
  PollCreateDialog,
  type PollCreateDialogData,
} from '../poll-create-dialog/poll-create-dialog';
import { openSessionAlternatives } from '../session-alternatives-dialog/open-session-alternatives';
import { openPinTime } from '../pin-time-dialog/open-pin-time';
import { SessionsApi } from '../../../core/sessions/sessions.api';

/** Гра для панелі: правило розкладу (для «Застосувати як розклад») і стан. */
export type PollsPanelGame = ScheduleRuleDialogData['game'] & Pick<GameDto, 'status'>;

/** Що панель уміє для сторінки гри (без посилання на клас — панель вантажиться відкладено). */
export interface PollsPanelHandle {
  reload(highlight?: boolean): Promise<boolean>;
}

interface Notice {
  kind: 'error' | 'info';
  key: string;
}

/** Завершених голосувань показуємо одразу стільки; решта — за кнопкою. */
const CLOSED_VISIBLE = 3;
/** Завершені й скасовані ігри: підбирати час уже нема для чого. */
const CLOSED_STATUSES = new Set<GameStatus>(['finished', 'cancelled']);
/** Голосування створюються й відповіді приймаються, поки гра набирає, триває чи на паузі. */
const POLL_STATUSES = new Set<GameStatus>(['recruiting', 'started', 'paused']);

const DIALOG = {
  autoFocus: 'first-tabbable',
  restoreFocus: true,
  maxWidth: 'calc(100vw - 32px)',
} as const;

/**
 * «Спільний час» на сторінці гри: голосування за час (учасникам — відповісти, майстру —
 * створити, завершити й застосувати) і, лише майстру, «Підібрати час». Посилання
 * `?poll=` фокусує голосування, `?session=` (майстру, зі сповіщення «не буду») відкриває
 * альтернативи сесії. Учаснику без голосувань панель не показується.
 */
@Component({
  selector: 'nri-polls-panel',
  imports: [MatButtonModule, MatIconModule, TranslatePipe, PollCard],
  templateUrl: './polls-panel.html',
  styleUrl: './polls-panel.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PollsPanel implements PollsPanelHandle {
  private readonly api = inject(SchedulingApi);
  private readonly sessionsApi = inject(SessionsApi);
  private readonly auth = inject(AuthStore);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly game = input.required<PollsPanelGame>();
  readonly isGm = input(false);
  /** `?poll=` — голосування, на яке веде посилання зі сповіщення. */
  readonly pollId = input<string | undefined>();
  /** `?session=` — сесія, для якої майстру показати альтернативи. */
  readonly sessionId = input<string | undefined>();
  /** Змінились розклад чи сесії (застосування, перенесення) — сторінці перечитати їх. */
  readonly changed = output<void>();
  /** Власна дія з голосуванням — пінг `polls` не має піднімати банер. */
  readonly mutated = output<void>();

  protected readonly polls = signal<PollDto[] | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly busy = signal(false);
  protected readonly notice = signal<Notice | null>(null);
  protected readonly showAllClosed = signal(false);
  protected readonly flash = new Highlighter<number>();
  protected readonly viewerZone = computed(() => viewerTimeZone(this.auth.me()));

  protected readonly paused = computed(() => this.game().status === 'paused');
  protected readonly canCreate = computed(
    () => this.isGm() && POLL_STATUSES.has(this.game().status),
  );
  protected readonly openPolls = computed(() =>
    (this.polls() ?? []).filter((p) => p.status === 'open'),
  );
  private readonly closedPolls = computed(() =>
    (this.polls() ?? []).filter((p) => p.status === 'closed'),
  );
  protected readonly visibleClosed = computed(() =>
    this.showAllClosed() ? this.closedPolls() : this.closedPolls().slice(0, CLOSED_VISIBLE),
  );
  protected readonly hiddenClosed = computed(
    () => this.closedPolls().length - this.visibleClosed().length,
  );
  /** Учасник бачить панель, лише коли є голосування. */
  protected readonly visible = computed(
    () => this.isGm() || (this.polls()?.length ?? 0) > 0 || this.notice() !== null,
  );
  /** «Підібрати час» — поки гру не завершено й не скасовано. */
  protected readonly canFind = computed(
    () => this.isGm() && !CLOSED_STATUSES.has(this.game().status),
  );

  private pollHandled: string | null = null;
  private sessionHandled: string | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.flash.dispose());
    // Лише зміна гри перечитує голосування (не кожне оновлення об'єкта гри сторінкою).
    const gameId = computed(() => this.game().id);
    effect(() => {
      const id = gameId();
      untracked(() => void this.load(id));
    });
    // `?poll=` — після завантаження фокус на голосування (і розгорнути завершені, якщо треба).
    effect(() => {
      const raw = this.pollId();
      const list = this.polls();
      if (!raw) {
        this.pollHandled = null;
        return;
      }
      if (!list || raw === this.pollHandled) return;
      this.pollHandled = raw;
      untracked(() => {
        this.clearParam('poll');
        const id = Number(raw);
        if (!list.some((p) => p.id === id)) {
          this.notice.set({ kind: 'info', key: 'scheduling.panel.pollMissing' });
          return;
        }
        if (!this.openPolls().some((p) => p.id === id)) this.showAllClosed.set(true);
        this.focus(`[data-poll-id="${id}"] h3`);
      });
    });
    // `?session=` — майстру альтернативи сесії (посилання зі сповіщення «не буду»); сесії з
    // приблизним часом (сповіщення «уточніть час») — «Уточнити час».
    effect(() => {
      const raw = this.sessionId();
      if (!raw) {
        this.sessionHandled = null;
        return;
      }
      if (!this.isGm() || raw === this.sessionHandled) return;
      this.sessionHandled = raw;
      untracked(() => {
        this.clearParam('session');
        const id = Number(raw);
        if (Number.isInteger(id) && id > 0) void this.alternatives(id);
      });
    });
  }

  async reload(highlight = false): Promise<boolean> {
    const before = this.polls();
    const ok = await this.load(this.game().id, true);
    const after = this.polls();
    if (highlight && ok && before && after && after !== before) {
      this.flash.flash(changedKeys(before, after, (p) => p.id));
    }
    return ok;
  }

  protected async retry(): Promise<void> {
    await this.load(this.game().id);
  }

  /** Голосування змінилось власною дією — оновлюємо його на місці. */
  protected replace(dto: PollDto): void {
    this.polls.update((list) => list?.map((p) => (p.id === dto.id ? dto : p)) ?? list);
  }

  protected onApplied(): void {
    this.changed.emit();
  }

  /** «Підібрати час» (майстер). */
  protected async findTimes(): Promise<void> {
    const g = this.game();
    if (this.busy() || !this.canFind()) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      const ref = this.dialog.open<
        CommonTimesDialog,
        CommonTimesDialogData,
        CommonTimesDialogResult
      >(CommonTimesDialog, {
        ...DIALOG,
        // Як «Інший час»: поки вміст вантажиться, перша фокусована — «Закрити» (тінт фокуса).
        autoFocus: 'dialog',
        width: '720px',
        data: {
          gameId: g.id,
          kind: g.kind,
          viewerTimezone: this.viewerZone(),
          paused: g.status === 'paused' || !POLL_STATUSES.has(g.status),
        },
      });
      const result = await firstValueFrom(ref.afterClosed());
      if (!result) return;
      if (result.kind === 'rescheduled') {
        this.afterChange('sessions.done.reschedule');
      } else if (result.kind === 'schedule') {
        await this.changeSchedule(result.startsAt, result.weekday);
      } else {
        await this.createPoll({ pollKind: result.pollKind, options: result.options });
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** «Створити голосування» без підбору (або з варіантами з підбору). */
  protected async newPoll(): Promise<void> {
    if (this.busy() || !this.canCreate()) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      await this.createPoll();
    } finally {
      this.busy.set(false);
    }
  }

  protected toggleClosed(): void {
    this.showAllClosed.update((v) => !v);
  }

  private async createPoll(prefill?: PollCreateDialogData['prefill']): Promise<void> {
    const g = this.game();
    if (!this.canCreate()) return;
    const ref = this.dialog.open<PollCreateDialog, PollCreateDialogData, PollDto>(
      PollCreateDialog,
      {
        ...DIALOG,
        width: '600px',
        data: {
          gameId: g.id,
          kind: g.kind,
          timezone: g.timezone,
          viewerTimezone: this.viewerZone(),
          prefill,
        },
      },
    );
    const poll = await firstValueFrom(ref.afterClosed());
    if (!poll) return;
    this.mutated.emit();
    this.polls.update((list) => [poll, ...(list ?? [])]);
    this.notice.set({ kind: 'info', key: 'scheduling.panel.created' });
    this.focus(`[data-poll-id="${poll.id}"] h3`);
  }

  /** «Застосувати як розклад»: наявний діалог розкладу з днем і часом варіанта. */
  private async changeSchedule(startsAt: string, weekday: number): Promise<void> {
    const g = this.game();
    if (g.kind !== 'campaign' || (g.status !== 'recruiting' && g.status !== 'started')) return;
    const ref = this.dialog.open<ScheduleRuleDialog, ScheduleRuleDialogData, GameDto>(
      ScheduleRuleDialog,
      {
        ...DIALOG,
        width: '600px',
        data: { game: g, mode: 'schedule', prefill: { startsAt, weekdays: [weekday] } },
      },
    );
    if (!(await firstValueFrom(ref.afterClosed()))) return;
    this.afterChange('games.details.scheduleChanged');
  }

  private async alternatives(sessionId: number): Promise<void> {
    // Те саме посилання веде й зі сповіщення «уточніть час»: спершу дізнаємось, чи час сесії
    // приблизний (помилка — як раніше, альтернативи самі пояснять, що сесія вже не актуальна).
    const slots = await firstValueFrom(this.sessionsApi.windowSlots(sessionId)).catch(() => null);
    if (slots && slots.startWindowMinutes !== null) {
      const pinned = await openPinTime(this.dialog, {
        sessionId,
        viewerTimezone: this.viewerZone(),
        slots,
      });
      if (pinned) this.afterChange('sessions.done.pin');
      return;
    }
    const session: SessionDto | null = await openSessionAlternatives(this.dialog, {
      sessionId,
      viewerTimezone: this.viewerZone(),
    });
    if (session) this.afterChange('sessions.done.reschedule');
  }

  private afterChange(key: string): void {
    this.changed.emit();
    this.notice.set({ kind: 'info', key });
    this.focus('.polls-notice');
  }

  private clearParam(name: 'poll' | 'session'): void {
    void this.router.navigate([], {
      queryParams: { [name]: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  private focus(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }

  private async load(gameId: number, silent = false): Promise<boolean> {
    if (!silent) this.loadFailed.set(false);
    try {
      this.polls.set(await firstValueFrom(this.api.polls(gameId)));
      return true;
    } catch (err) {
      const { code } = toApiError(err);
      if (code === 'UNAUTHENTICATED') return false;
      if (silent) this.notice.set({ kind: 'error', key: `errors.${code}` });
      else this.loadFailed.set(true);
      return false;
    }
  }
}
