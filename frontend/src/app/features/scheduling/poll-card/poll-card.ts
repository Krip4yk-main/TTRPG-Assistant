import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import {
  POLL_VOTE_VALUES,
  type GameKind,
  type PollApplyInput,
  type PollApplyResultDto,
  type PollDto,
  type PollOptionDto,
  type PollVoteValue,
  type Weekday,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { formatDateTime } from '../../../core/i18n/dates';
import { SchedulingApi } from '../../../core/scheduling/scheduling.api';
import {
  ConfirmDialog,
  type ConfirmDialogData,
} from '../../../shared/confirm-dialog/confirm-dialog';
import { formatSlot, weeklySlot } from '../scheduling-format';

const VOTE_ICONS: Record<PollVoteValue, string> = {
  yes: 'check_circle',
  maybe: 'help',
  no: 'cancel',
};
/** Порядок кнопок: «можу», «якщо треба», «не можу». */
const VOTE_ORDER: readonly PollVoteValue[] = ['yes', 'maybe', 'no'];

interface Message {
  kind: 'error' | 'info';
  key: string;
}

/** Застосування, що чекає рішення майстра (кілька днів у розкладі / сесії вже немає). */
type Pending =
  | { kind: 'weekdays'; optionId: number; current: Weekday[]; choice: 'replace' | 'add' }
  | { kind: 'newSession'; optionId: number };

/**
 * Одне голосування за час: варіанти в поясі глядача, підсумки «можу / якщо треба / не можу»,
 * хто вже відповів. Учасник відповідає кнопками біля кожного варіанта (змінює до закриття);
 * майстер може завершити голосування раніше й застосувати переможця чи інший варіант через
 * наявні зміни розкладу / перенесення сесії (з підтвердженням для кількох днів розкладу).
 */
@Component({
  selector: 'nri-poll-card',
  imports: [MatButtonModule, MatIconModule, TranslatePipe],
  templateUrl: './poll-card.html',
  styleUrl: './poll-card.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PollCard {
  private readonly api = inject(SchedulingApi);
  private readonly auth = inject(AuthStore);
  private readonly dialog = inject(MatDialog);

  readonly poll = input.required<PollDto>();
  readonly viewerTimezone = input.required<string>();
  readonly gameKind = input.required<GameKind>();
  /** Кампейн на паузі: застосувати не можна (лише відновленням). */
  readonly paused = input(false);
  /** Голосування змінилось (власна дія) — список оновлює його на місці. */
  readonly changed = output<PollDto>();
  /** Результат застосовано — сторінка перечитує гру й сесії. */
  readonly applied = output<PollApplyResultDto>();
  /** Глядач сам змінив дані: власний пінг `polls` не має піднімати банер. */
  readonly mutated = output<void>();

  protected readonly voteValues = VOTE_ORDER;
  protected readonly voteIcons = VOTE_ICONS;
  protected readonly busy = signal(false);
  protected readonly message = signal<Message | null>(null);
  protected readonly pending = signal<Pending | null>(null);

  private readonly myId = computed(() => this.auth.me()?.id ?? null);
  protected readonly open = computed(() => this.poll().status === 'open');
  protected readonly votedCount = computed(() => this.poll().voters.filter((v) => v.voted).length);
  /** Можна застосувати: майстер, голосування закрите й ще не застосоване, гру не закрито. */
  protected readonly canApply = computed(() => {
    const p = this.poll();
    return p.isGm && p.status === 'closed' && !p.appliedAt && p.closeReason !== 'game_closed';
  });
  protected readonly titleKey = computed(() => {
    const p = this.poll();
    if (p.kind === 'regular') return 'scheduling.poll.title.regular';
    if (p.sessionId !== null) return 'scheduling.poll.title.reschedule';
    return this.gameKind() === 'campaign'
      ? 'scheduling.poll.title.newSession'
      : 'scheduling.poll.title.oneshot';
  });
  protected readonly closesLabel = computed(() =>
    formatDateTime(this.poll().closesAt, this.viewerTimezone()),
  );
  private readonly nicknames = computed(
    () => new Map(this.poll().voters.map((v) => [v.userId, v.nickname])),
  );

  protected optionLabel(o: PollOptionDto): { weekly: boolean; day: Weekday; text: string } {
    if (o.weekday !== null) {
      const slot = weeklySlot(o.startsAt, this.viewerTimezone());
      return { weekly: true, day: slot.weekday, text: slot.time };
    }
    return { weekly: false, day: 0, text: formatSlot(o.startsAt, this.viewerTimezone()) };
  }

  protected myVote(o: PollOptionDto): PollVoteValue | null {
    const me = this.myId();
    return o.votes.find((v) => v.userId === me)?.value ?? null;
  }

  /** Хто як відповів на варіант — у порядку «можу», «якщо треба», «не можу». */
  protected answers(o: PollOptionDto): { nickname: string | null; value: PollVoteValue }[] {
    const names = this.nicknames();
    return [...o.votes]
      .sort((a, b) => POLL_VOTE_VALUES.indexOf(a.value) - POLL_VOTE_VALUES.indexOf(b.value))
      .map((v) => ({ nickname: names.get(v.userId) ?? null, value: v.value }));
  }

  protected async vote(o: PollOptionDto, value: PollVoteValue): Promise<void> {
    const p = this.poll();
    if (this.busy() || !p.canVote || this.myVote(o) === value) return;
    this.busy.set(true);
    this.message.set(null);
    this.mutated.emit();
    try {
      const dto = await firstValueFrom(this.api.vote(p.id, { votes: [{ optionId: o.id, value }] }));
      this.mutated.emit();
      this.changed.emit(dto);
      this.message.set({
        kind: 'info',
        key: dto.status === 'closed' ? 'scheduling.poll.votedClosed' : 'scheduling.poll.voted',
      });
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy.set(false);
    }
  }

  /** «Завершити зараз» (майстер) — після підтвердження. */
  protected async close(): Promise<void> {
    const p = this.poll();
    if (this.busy() || !p.isGm || p.status !== 'open') return;
    const ref = this.dialog.open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
      data: {
        title: 'scheduling.poll.closeConfirm.title',
        text: 'scheduling.poll.closeConfirm.text',
        confirm: 'scheduling.poll.closeConfirm.confirm',
      },
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    if (!(await firstValueFrom(ref.afterClosed()))) return;
    this.busy.set(true);
    this.message.set(null);
    this.mutated.emit();
    try {
      const dto = await firstValueFrom(this.api.closePoll(p.id));
      this.mutated.emit();
      this.changed.emit(dto);
      this.message.set({ kind: 'info', key: 'scheduling.poll.closed' });
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy.set(false);
    }
  }

  protected async apply(optionId: number): Promise<void> {
    this.pending.set(null);
    await this.runApply({ optionId });
  }

  protected setChoice(choice: 'replace' | 'add'): void {
    this.pending.update((p) => (p?.kind === 'weekdays' ? { ...p, choice } : p));
  }

  /** Підтвердити рішення з панелі (дні розкладу чи нова сесія). */
  protected async confirmPending(): Promise<void> {
    const p = this.pending();
    if (!p) return;
    if (p.kind === 'newSession') {
      await this.runApply({ optionId: p.optionId, asNewSession: true });
      return;
    }
    const option = this.poll().options.find((o) => o.id === p.optionId);
    if (option?.weekday === null || option?.weekday === undefined) return;
    const day = option.weekday;
    const weekdays =
      p.choice === 'replace' ? [day] : [...new Set([...p.current, day])].sort((a, b) => a - b);
    await this.runApply({ optionId: p.optionId, weekdays });
  }

  protected cancelPending(): void {
    this.pending.set(null);
  }

  /** Час варіанта, що стане часом усіх днів розкладу (у поясі глядача). */
  protected pendingTime(): string {
    const p = this.pending();
    const o = p && this.poll().options.find((x) => x.id === p.optionId);
    return o ? weeklySlot(o.startsAt, this.viewerTimezone()).time : '';
  }

  private async runApply(input: PollApplyInput): Promise<void> {
    const p = this.poll();
    if (this.busy() || !this.canApply()) return;
    this.busy.set(true);
    this.message.set(null);
    this.mutated.emit();
    try {
      const result = await firstValueFrom(this.api.applyPoll(p.id, input));
      this.pending.set(null);
      this.mutated.emit();
      this.changed.emit(result.poll);
      this.message.set({
        kind: 'info',
        key:
          result.applied.kind === 'schedule'
            ? 'scheduling.poll.appliedSchedule'
            : 'scheduling.poll.appliedSession',
      });
      this.applied.emit(result);
    } catch (err) {
      const { code, details } = toApiError(err);
      const optionId = input.optionId ?? p.winnerOptionId;
      if (code === 'POLL_APPLY_CONFIRM' && optionId) {
        const current = (details as { currentWeekdays?: Weekday[] } | undefined)?.currentWeekdays;
        this.pending.set({ kind: 'weekdays', optionId, current: current ?? [], choice: 'replace' });
      } else if (
        code === 'SESSION_INVALID_STATE' &&
        p.kind === 'one_off' &&
        p.sessionId !== null &&
        optionId &&
        !input.asNewSession
      ) {
        this.pending.set({ kind: 'newSession', optionId });
      } else {
        this.fail(err);
      }
    } finally {
      this.busy.set(false);
    }
  }

  private fail(err: unknown): void {
    const { code } = toApiError(err);
    if (code === 'UNAUTHENTICATED') return;
    this.message.set({
      kind: 'error',
      key: code === 'GAME_IN_PAST' ? 'scheduling.poll.optionPast' : `errors.${code}`,
    });
  }
}
