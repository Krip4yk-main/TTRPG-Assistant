import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { TranslatePipe } from '@ngx-translate/core';
import {
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  type CommonTimesDto,
  type GameKind,
  type OneOffCandidateDto,
  type RegularCandidateDto,
  type SessionDto,
  type Weekday,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { formatDateTime } from '../../../core/i18n/dates';
import { SchedulingApi } from '../../../core/scheduling/scheduling.api';
import { SessionsApi } from '../../../core/sessions/sessions.api';
import { ParticipantStatuses } from '../participant-statuses/participant-statuses';
import { formatSlot, weeklySlot } from '../scheduling-format';

export interface CommonTimesDialogData {
  gameId: number;
  kind: GameKind;
  /** Пояс глядача: у ньому показуються всі варіанти. */
  viewerTimezone: string;
  /** Кампейн на паузі: розклад змінюється лише відновленням — «Застосувати» сховано. */
  paused: boolean;
}

/** Варіант для голосування (як у `pollCreateSchema`) і його перша сесія — для показу. */
export type PollOptionPrefill =
  { weekday: Weekday; startMin: number; startsAt: string } | { startsAt: string };

export type CommonTimesDialogResult =
  /** «Застосувати як розклад»: відкрити діалог розкладу з цим днем і часом. */
  | { kind: 'schedule'; startsAt: string; weekday: Weekday }
  /** «Створити голосування з варіантів». */
  | { kind: 'poll'; pollKind: 'regular' | 'one_off'; options: PollOptionPrefill[] }
  /** Сесію перенесено (запит зроблено тут). */
  | { kind: 'rescheduled'; session: SessionDto };

type Tab = 'regular' | 'oneOff';

/**
 * «Підібрати час» (лише майстер): найкращі регулярні (день тижня + час) і разові варіанти на
 * 4 тижні з тим, хто може / не може / невідомо. Звідси — застосувати як розклад, перенести
 * сесію чи зібрати 2–6 варіантів у голосування. Час — у поясі глядача.
 */
@Component({
  selector: 'nri-common-times-dialog',
  imports: [
    MatButtonModule,
    MatButtonToggleModule,
    MatCheckboxModule,
    MatDialogModule,
    MatIconModule,
    MatSelectModule,
    TranslatePipe,
    ParticipantStatuses,
  ],
  templateUrl: './common-times-dialog.html',
  styleUrl: './common-times-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommonTimesDialog {
  protected readonly data = inject<CommonTimesDialogData>(MAT_DIALOG_DATA);
  private readonly ref =
    inject<MatDialogRef<CommonTimesDialog, CommonTimesDialogResult>>(MatDialogRef);
  private readonly api = inject(SchedulingApi);
  private readonly sessionsApi = inject(SessionsApi);

  protected readonly min = POLL_MIN_OPTIONS;
  protected readonly max = POLL_MAX_OPTIONS;
  protected readonly campaign = this.data.kind === 'campaign';
  private readonly tz = this.data.viewerTimezone;

  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly result = signal<CommonTimesDto | null>(null);
  protected readonly tab = signal<Tab>(this.campaign ? 'regular' : 'oneOff');
  /** Обрані для голосування (ключі варіантів поточної вкладки). */
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly canPoll = computed(() => {
    const n = this.selected().size;
    return n >= POLL_MIN_OPTIONS && n <= POLL_MAX_OPTIONS;
  });

  /** Перенесення: варіант, для якого відкрито вибір сесії. */
  protected readonly moving = signal<string | null>(null);
  protected readonly sessions = signal<SessionDto[] | null>(null);
  protected readonly targetId = signal<number | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.state.set('loading');
    try {
      this.result.set(await firstValueFrom(this.api.commonTimes(this.data.gameId)));
      this.state.set('ready');
    } catch (err) {
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') this.state.set('error');
    }
  }

  protected setTab(tab: Tab): void {
    if (tab === this.tab()) return;
    this.tab.set(tab);
    this.selected.set(new Set());
    this.moving.set(null);
  }

  protected regularKey(c: RegularCandidateDto): string {
    return `${c.weekday}:${c.startMin}`;
  }

  /** Регулярний варіант у поясі глядача: день тижня й час його першої сесії. */
  protected weekly(c: RegularCandidateDto): { weekday: Weekday; time: string } {
    return weeklySlot(c.firstStartsAt, this.tz);
  }

  protected firstLabel(c: RegularCandidateDto): string {
    return formatDateTime(c.firstStartsAt, this.tz);
  }

  protected oneOffLabel(c: OneOffCandidateDto): string {
    return formatSlot(c.startsAt, this.tz);
  }

  protected isSelected(key: string): boolean {
    return this.selected().has(key);
  }

  /** Понад 6 обрати не можна — решта прапорців вимикається. */
  protected selectionFull(key: string): boolean {
    return !this.selected().has(key) && this.selected().size >= POLL_MAX_OPTIONS;
  }

  protected toggle(key: string, on: boolean): void {
    this.selected.update((set) => {
      const next = new Set(set);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  protected applySchedule(c: RegularCandidateDto): void {
    this.ref.close({ kind: 'schedule', startsAt: c.firstStartsAt, weekday: c.weekday });
  }

  protected createPoll(): void {
    const r = this.result();
    if (!r || !this.canPoll()) return;
    const keys = this.selected();
    if (this.tab() === 'regular') {
      const options = r.regular
        .filter((c) => keys.has(this.regularKey(c)))
        .map((c) => ({ weekday: c.weekday, startMin: c.startMin, startsAt: c.firstStartsAt }));
      this.ref.close({ kind: 'poll', pollKind: 'regular', options });
    } else {
      const options = r.oneOff
        .filter((c) => keys.has(c.startsAt))
        .map((c) => ({ startsAt: c.startsAt }));
      this.ref.close({ kind: 'poll', pollKind: 'one_off', options });
    }
  }

  /** «Перенести сесію» на разовий варіант: спершу вибір, яку саме сесію. */
  protected async startMove(c: OneOffCandidateDto): Promise<void> {
    this.error.set(null);
    this.moving.set(c.startsAt);
    if (this.sessions()) return;
    try {
      const list = await firstValueFrom(this.sessionsApi.list(this.data.gameId));
      const now = Date.now();
      const upcoming = list.filter((s) => s.status === 'scheduled' && Date.parse(s.startsAt) > now);
      this.sessions.set(upcoming);
      this.targetId.set(upcoming[0]?.id ?? null);
    } catch (err) {
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') this.error.set(`errors.${code}`);
      this.moving.set(null);
    }
  }

  protected cancelMove(): void {
    this.moving.set(null);
    this.error.set(null);
  }

  protected sessionLabel(s: SessionDto): string {
    return formatSlot(s.startsAt, this.tz);
  }

  protected setTarget(value: number): void {
    this.targetId.set(value || null);
  }

  protected async move(c: OneOffCandidateDto): Promise<void> {
    const id = this.targetId();
    if (id === null || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const session = await firstValueFrom(
        // Кандидат — точний час: вікно (якщо було) знімаємо.
        this.sessionsApi.reschedule(id, { startsAt: c.startsAt, startWindowMinutes: null }),
      );
      this.ref.close({ kind: 'rescheduled', session });
    } catch (err) {
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') {
        this.error.set(code === 'GAME_IN_PAST' ? 'scheduling.finder.past' : `errors.${code}`);
      }
      this.busy.set(false);
    }
  }

  protected close(): void {
    this.ref.close();
  }
}
