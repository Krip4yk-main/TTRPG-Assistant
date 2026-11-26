import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { OneOffCandidateDto, SessionAlternativesDto, SessionDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { SchedulingApi } from '../../../core/scheduling/scheduling.api';
import { SessionsApi } from '../../../core/sessions/sessions.api';
import { ParticipantStatuses } from '../participant-statuses/participant-statuses';
import { formatSlot } from '../scheduling-format';

export interface SessionAlternativesDialogData {
  sessionId: number;
  /** Пояс глядача: у ньому показуються всі варіанти. */
  viewerTimezone: string;
}

/**
 * «Інший час для сесії» (лише майстер; відкривається й посиланням зі сповіщення «не буду»):
 * до 3 найкращих варіантів у ±3 доби від сесії з тим, хто може / не може / невідомо, і
 * перенесення одним кліком наявним `reschedule`. Сесія вже минула, перенесена чи скасована
 * (409) — пояснення замість списку. Закривається з оновленою `SessionDto`.
 */
@Component({
  selector: 'nri-session-alternatives-dialog',
  imports: [MatButtonModule, MatDialogModule, MatIconModule, TranslatePipe, ParticipantStatuses],
  templateUrl: './session-alternatives-dialog.html',
  styleUrl: './session-alternatives-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionAlternativesDialog {
  protected readonly data = inject<SessionAlternativesDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<SessionAlternativesDialog, SessionDto>>(MatDialogRef);
  private readonly api = inject(SchedulingApi);
  private readonly sessions = inject(SessionsApi);

  protected readonly state = signal<'loading' | 'ready' | 'stale' | 'error'>('loading');
  protected readonly result = signal<SessionAlternativesDto | null>(null);
  protected readonly busy = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.state.set('loading');
    this.error.set(null);
    try {
      this.result.set(await firstValueFrom(this.api.alternatives(this.data.sessionId)));
      this.state.set('ready');
    } catch (err) {
      const { status, code } = toApiError(err);
      if (code === 'UNAUTHENTICATED') return;
      this.state.set(status === 409 || status === 404 ? 'stale' : 'error');
    }
  }

  protected label(iso: string): string {
    return formatSlot(iso, this.data.viewerTimezone);
  }

  protected async move(c: OneOffCandidateDto): Promise<void> {
    if (this.busy()) return;
    this.busy.set(c.startsAt);
    this.error.set(null);
    try {
      this.ref.close(
        await firstValueFrom(
          this.sessions.reschedule(this.data.sessionId, { startsAt: c.startsAt }),
        ),
      );
    } catch (err) {
      const { code } = toApiError(err);
      if (code === 'SESSION_INVALID_STATE') this.state.set('stale');
      else if (code === 'GAME_IN_PAST') this.error.set('scheduling.finder.past');
      else if (code !== 'UNAUTHENTICATED') this.error.set(`errors.${code}`);
      this.busy.set(null);
    }
  }

  protected close(): void {
    this.ref.close();
  }
}
