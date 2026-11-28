import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { TranslatePipe } from '@ngx-translate/core';
import {
  nextWeeklyStart,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  type GameKind,
  type PollCreateInput,
  type PollDto,
  type PollKind,
  type SessionDto,
  type Weekday,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import {
  differentZones,
  formatDateTime,
  fromIsoDate,
  zonedInputToUtc,
} from '../../../core/i18n/dates';
import { SchedulingApi } from '../../../core/scheduling/scheduling.api';
import { SessionsApi } from '../../../core/sessions/sessions.api';
import type { PollOptionPrefill } from '../common-times-dialog/common-times-dialog';
import { formatSlot, weeklySlot } from '../scheduling-format';

export interface PollCreateDialogData {
  gameId: number;
  kind: GameKind;
  /** Пояс гри: у ньому вводяться варіанти вручну. */
  timezone: string;
  viewerTimezone: string;
  /** Варіанти з підбору спільного часу. */
  prefill?: { pollKind: PollKind; options: PollOptionPrefill[] };
}

/** Варіант у формі: `startsAt` — момент для показу (для регулярного — найближча сесія). */
interface OptionDraft {
  key: string;
  weekday: Weekday | null;
  startMin: number | null;
  startsAt: string;
}

/** Строк голосування — від «зараз», год (≤ 14 днів). */
const DEADLINES = [12, 24, 48, 72, 168, 336] as const;
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const HOUR_MS = 3_600_000;

const draftKey = (o: Pick<OptionDraft, 'weekday' | 'startMin' | 'startsAt'>) =>
  o.weekday !== null ? `${o.weekday}:${o.startMin}` : o.startsAt;

/**
 * «Створити голосування» (лише майстер): 2–6 варіантів — з підбору або вручну (у поясі гри,
 * з підказкою у поясі глядача), строк до 14 днів і, для разових, сесія, яку переносимо (без
 * неї кампейн отримає нову сесію). Закривається зі створеним `PollDto`.
 */
@Component({
  selector: 'nri-poll-create-dialog',
  imports: [
    MatButtonModule,
    MatButtonToggleModule,
    MatDialogModule,
    MatIconModule,
    MatSelectModule,
    TranslatePipe,
  ],
  templateUrl: './poll-create-dialog.html',
  styleUrl: './poll-create-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PollCreateDialog {
  protected readonly data = inject<PollCreateDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<PollCreateDialog, PollDto>>(MatDialogRef);
  private readonly api = inject(SchedulingApi);
  private readonly sessionsApi = inject(SessionsApi);

  protected readonly min = POLL_MIN_OPTIONS;
  protected readonly max = POLL_MAX_OPTIONS;
  protected readonly deadlines = DEADLINES;
  protected readonly weekdays = WEEKDAYS;
  protected readonly campaign = this.data.kind === 'campaign';
  protected readonly zoneDiffers = differentZones(this.data.timezone, this.data.viewerTimezone);
  /** Вид змінюється лише без варіантів з підбору (ваншот — завжди разові). */
  protected readonly kindLocked = !!this.data.prefill || !this.campaign;

  protected readonly pollKind = signal<PollKind>(
    this.data.prefill?.pollKind ?? (this.campaign ? 'regular' : 'one_off'),
  );
  protected readonly options = signal<OptionDraft[]>(
    (this.data.prefill?.options ?? []).map((o) => {
      const d: OptionDraft =
        'weekday' in o
          ? { key: '', weekday: o.weekday, startMin: o.startMin, startsAt: o.startsAt }
          : { key: '', weekday: null, startMin: null, startsAt: o.startsAt };
      return { ...d, key: draftKey(d) };
    }),
  );
  protected readonly deadlineHours = signal<number>(48);
  protected readonly closesAt = computed(() =>
    new Date(Date.now() + this.deadlineHours() * HOUR_MS).toISOString(),
  );

  /** Ручне додавання: поля в поясі гри. */
  protected readonly addWeekday = signal<Weekday>(4);
  protected readonly addDate = signal('');
  protected readonly addTime = signal('19:00');
  protected readonly addError = signal<string | null>(null);

  /** Разові: сесія, яку переносимо (`null` — нова сесія / єдина сесія ваншота). */
  protected readonly sessions = signal<SessionDto[]>([]);
  protected readonly targetId = signal<number | null>(null);

  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    // Разові варіанти з підбору бувають уже за день-два: строк — найдовший, що встигає до них.
    if (this.pollKind() === 'one_off' && this.options().length) {
      const earliest = Math.min(...this.options().map((o) => Date.parse(o.startsAt)));
      const fits = DEADLINES.filter((h) => Date.now() + h * HOUR_MS < earliest - HOUR_MS);
      this.deadlineHours.set(fits.includes(48) ? 48 : (fits.at(-1) ?? DEADLINES[0]));
    }
    void this.loadSessions();
  }

  protected setKind(kind: PollKind): void {
    if (this.kindLocked || kind === this.pollKind()) return;
    this.pollKind.set(kind);
    this.options.set([]);
    this.addError.set(null);
  }

  protected optionLabel(o: OptionDraft): { weekly: boolean; day: Weekday; text: string } {
    if (o.weekday !== null) {
      const slot = weeklySlot(o.startsAt, this.data.viewerTimezone);
      return { weekly: true, day: slot.weekday, text: slot.time };
    }
    return { weekly: false, day: 0, text: formatSlot(o.startsAt, this.data.viewerTimezone) };
  }

  protected remove(key: string): void {
    this.options.update((list) => list.filter((o) => o.key !== key));
  }

  protected deadlineLabel(): string {
    return formatDateTime(this.closesAt(), this.data.viewerTimezone);
  }

  protected sessionLabel(s: SessionDto): string {
    return formatSlot(s.startsAt, this.data.viewerTimezone);
  }

  /** Підказка ручного варіанта в поясі глядача (коли пояси різні). */
  protected addPreview(): string | null {
    if (!this.zoneDiffers) return null;
    const draft = this.draftFromInputs();
    return draft ? formatDateTime(draft.startsAt, this.data.viewerTimezone) : null;
  }

  protected add(): void {
    this.addError.set(null);
    if (this.options().length >= POLL_MAX_OPTIONS) return;
    const draft = this.draftFromInputs();
    if (!draft) {
      this.addError.set('scheduling.create.addInvalid');
      return;
    }
    if (draft.weekday === null && Date.parse(draft.startsAt) <= Date.now()) {
      this.addError.set('scheduling.finder.past');
      return;
    }
    if (this.options().some((o) => o.key === draft.key)) {
      this.addError.set('scheduling.create.duplicate');
      return;
    }
    this.options.update((list) => [...list, draft]);
  }

  protected setWeekday(value: number): void {
    const d = value;
    if (Number.isInteger(d) && d >= 0 && d <= 6) this.addWeekday.set(d as Weekday);
  }

  protected setTarget(value: number): void {
    this.targetId.set(value || null);
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    this.error.set(null);
    const options = this.options();
    if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) {
      this.error.set('scheduling.create.count');
      return;
    }
    const closesAt = this.closesAt();
    let input: PollCreateInput;
    if (this.pollKind() === 'regular') {
      input = {
        kind: 'regular',
        closesAt,
        options: options.map((o) => ({ weekday: o.weekday!, startMin: o.startMin! })),
      };
    } else {
      // Разова сесія не може настати до кінця голосування.
      if (options.some((o) => o.startsAt <= closesAt)) {
        this.error.set('scheduling.create.afterDeadline');
        return;
      }
      const target = this.targetId();
      input = {
        kind: 'one_off',
        closesAt,
        options: options.map((o) => ({ startsAt: o.startsAt })),
        ...(target !== null ? { sessionId: target } : {}),
      };
    }
    this.submitting.set(true);
    try {
      this.ref.close(await firstValueFrom(this.api.createPoll(this.data.gameId, input)));
    } catch (err) {
      const { code } = toApiError(err);
      if (code === 'GAME_IN_PAST') this.error.set('scheduling.finder.past');
      else if (code !== 'UNAUTHENTICATED') this.error.set(`errors.${code}`);
      this.submitting.set(false);
    }
  }

  protected cancel(): void {
    this.ref.close();
  }

  private draftFromInputs(): OptionDraft | null {
    const m = /^(\d{2}):(\d{2})$/.exec(this.addTime());
    if (!m) return null;
    const startMin = Number(m[1]) * 60 + Number(m[2]);
    const tz = this.data.timezone;
    if (this.pollKind() === 'regular') {
      const weekday = this.addWeekday();
      const startsAt = nextWeeklyStart(tz, weekday, startMin, new Date()).toISOString();
      return { key: `${weekday}:${startMin}`, weekday, startMin, startsAt };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(this.addDate())) return null;
    const startsAt = zonedInputToUtc(fromIsoDate(this.addDate()), this.addTime(), tz);
    return startsAt ? { key: startsAt, weekday: null, startMin: null, startsAt } : null;
  }

  private async loadSessions(): Promise<void> {
    if (this.pollKind() === 'regular' && this.kindLocked) return;
    try {
      const list = await firstValueFrom(this.sessionsApi.list(this.data.gameId));
      const now = Date.now();
      this.sessions.set(
        list.filter((s) => s.status === 'scheduled' && Date.parse(s.startsAt) > now),
      );
    } catch {
      // Без списку — голосування за нову сесію (чи за єдину сесію ваншота).
    }
  }
}
