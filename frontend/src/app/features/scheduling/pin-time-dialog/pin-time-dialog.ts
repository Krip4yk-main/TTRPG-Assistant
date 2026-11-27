import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import {
  START_WINDOW_STEP,
  windowEnd,
  type OneOffCandidateDto,
  type SessionDto,
  type SessionWindowSlotsDto,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { formatWindow } from '../../../core/i18n/dates';
import { SessionsApi } from '../../../core/sessions/sessions.api';
import { ParticipantStatuses } from '../participant-statuses/participant-statuses';
import { formatSlot } from '../scheduling-format';

export interface PinTimeDialogData {
  sessionId: number;
  /** Пояс глядача: у ньому показуються всі варіанти. */
  viewerTimezone: string;
  /** Уже завантажені варіанти (щоб не просити їх удруге); немає — діалог завантажить сам. */
  slots?: SessionWindowSlotsDto;
}

/** Варіант точного старту у вікні. */
interface PinOption {
  startsAt: string;
  /** Старт уже минув: оцінки зайнятості немає (сервер рахує лише майбутні старти). */
  past: boolean;
  slot: OneOffCandidateDto | null;
}

const STEP_MS = START_WINDOW_STEP * 60_000;

/**
 * «Уточнити час» (лише майстер) сесії з приблизним часом: кожен 30-хв старт у вікні «з … до …»
 * з тим, хто з учасників може / не може / невідомо (`window-slots`), і вибір одним кліком —
 * перенесення на точний час (`startWindowMinutes: null`). Вікно, що вже почалось, дає обрати
 * й минулий старт (коли сесія фактично почалась): сервер дозволяє це в межах вікна, RSVP
 * лишаються, учасникам про минулий час нічого не надходить. Сесія вже не запланована (409/404)
 * — пояснення замість списку. Закривається з оновленою `SessionDto`.
 */
@Component({
  selector: 'nri-pin-time-dialog',
  imports: [MatButtonModule, MatDialogModule, MatIconModule, TranslatePipe, ParticipantStatuses],
  templateUrl: './pin-time-dialog.html',
  styleUrl: './pin-time-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PinTimeDialog {
  protected readonly data = inject<PinTimeDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<PinTimeDialog, SessionDto>>(MatDialogRef);
  private readonly sessions = inject(SessionsApi);

  protected readonly state = signal<'loading' | 'ready' | 'exact' | 'stale' | 'error'>('loading');
  protected readonly result = signal<SessionWindowSlotsDto | null>(null);
  protected readonly busy = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  /** Момент завантаження — межа минулих і майбутніх стартів. */
  private readonly loadedAt = signal(Date.now());

  /** Усі старти вікна від початку до кінця включно (UTC-мс), з оцінкою для майбутніх. */
  protected readonly options = computed<PinOption[]>(() => {
    const r = this.result();
    if (!r || r.startWindowMinutes === null) return [];
    const bySlot = new Map(r.slots.map((s) => [Date.parse(s.startsAt), s]));
    const start = new Date(r.startsAt);
    const last = windowEnd(start, r.startWindowMinutes).getTime();
    const now = this.loadedAt();
    const list: PinOption[] = [];
    for (let t = start.getTime(); t <= last; t += STEP_MS) {
      const slot = bySlot.get(t) ?? null;
      list.push({ startsAt: new Date(t).toISOString(), past: !slot && t <= now, slot });
    }
    return list;
  });
  protected readonly hasPast = computed(() => this.options().some((o) => o.past));

  constructor() {
    if (this.data.slots) this.show(this.data.slots);
    else void this.load();
  }

  protected async load(): Promise<void> {
    this.state.set('loading');
    this.error.set(null);
    try {
      this.show(await firstValueFrom(this.sessions.windowSlots(this.data.sessionId)));
    } catch (err) {
      const { status, code } = toApiError(err);
      if (code === 'UNAUTHENTICATED') return;
      this.state.set(status === 409 || status === 404 ? 'stale' : 'error');
    }
  }

  private show(r: SessionWindowSlotsDto): void {
    this.loadedAt.set(Date.now());
    this.result.set(r);
    this.state.set(r.startWindowMinutes === null ? 'exact' : 'ready');
  }

  protected current(r: SessionWindowSlotsDto): string {
    return formatWindow(r.startsAt, r.startWindowMinutes, this.data.viewerTimezone);
  }

  protected label(iso: string): string {
    return formatSlot(iso, this.data.viewerTimezone);
  }

  protected async pin(o: PinOption): Promise<void> {
    if (this.busy()) return;
    this.busy.set(o.startsAt);
    this.error.set(null);
    try {
      this.ref.close(
        await firstValueFrom(
          this.sessions.reschedule(this.data.sessionId, {
            startsAt: o.startsAt,
            startWindowMinutes: null,
          }),
        ),
      );
    } catch (err) {
      const { code } = toApiError(err);
      if (code === 'SESSION_INVALID_STATE') this.state.set('stale');
      else if (code === 'GAME_IN_PAST') this.error.set('sessions.pin.past');
      else if (code !== 'UNAUTHENTICATED') this.error.set(`errors.${code}`);
      this.busy.set(null);
    }
  }

  protected close(): void {
    this.ref.close();
  }
}
