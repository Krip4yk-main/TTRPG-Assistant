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
import { NgTemplateOutlet } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { SessionDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { NotesApi, type NoteSource } from '../../../core/notes/notes.api';
import { differentZones, formatDateTime, viewerTimeZone } from '../../../core/i18n/dates';
import { SessionsApi } from '../../../core/sessions/sessions.api';
import { NoteEditor } from '../../notes/note-editor/note-editor';
import {
  FinishSessionDialog,
  type FinishSessionDialogData,
} from '../finish-session-dialog/finish-session-dialog';
import {
  CancelSessionDialog,
  type CancelSessionDialogData,
} from '../session-actions/cancel-session-dialog';
import { RescheduleDialog, type RescheduleDialogData } from '../session-actions/reschedule-dialog';

/** Дія майстра над сесією. */
export type SessionAction = 'reschedule' | 'cancel' | 'finish';

interface Message {
  kind: 'error' | 'info';
  key: string;
}

/** Як часто оновлюється «зараз» (межа майбутніх і минулих, «очікує завершення»), мс. */
const CLOCK_MS = 60_000;

/** Причини автоскасування сесій бекендом (`cancel_reason` — код, а не текст майстра). */
const SYSTEM_CANCEL_REASONS = ['game_finished', 'game_cancelled', 'rule_changed'] as const;

const DIALOG_OPTIONS = {
  autoFocus: 'first-tabbable',
  restoreFocus: true,
  width: '560px',
  maxWidth: 'calc(100vw - 32px)',
} as const;

/**
 * Сесії гри (сторінка гри — майстру й активним учасникам): майбутні й минулі, статус,
 * позначка «перенесено», причина скасування, підсумок. Час — у поясі глядача з назвою поясу,
 * якщо він відрізняється від поясу гри. Майстер (поки гра набирає чи йде) може перенести чи
 * скасувати заплановану сесію, а завершити — лише ту, що вже почалась.
 */
@Component({
  selector: 'nri-sessions-list',
  imports: [NgTemplateOutlet, MatButtonModule, MatIconModule, TranslatePipe, NoteEditor],
  templateUrl: './sessions-list.html',
  styleUrl: './sessions-list.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionsList {
  private readonly api = inject(SessionsApi);
  private readonly auth = inject(AuthStore);
  private readonly dialog = inject(MatDialog);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly notes = inject(NotesApi);

  readonly gameId = input.required<number>();
  /** IANA-пояс гри. */
  readonly timezone = input.required<string>();
  readonly isGm = input(false);
  /** Гра `recruiting`/`started`: сесіями можна керувати. */
  readonly manageable = input(false);
  /** Сесії змінились — сторінці варто оновити «найближчу сесію». */
  readonly changed = output<void>();

  protected readonly sessions = signal<SessionDto[] | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly busy = signal(false);
  protected readonly message = signal<Message | null>(null);
  /**
   * «Зараз» — єдина межа між майбутніми й минулими для списку, статусу й дій майстра;
   * оновлюється щохвилини й після кожного завантаження.
   */
  private readonly now = signal(Date.now());
  /** Сесії з розгорнутою приватною нотаткою. */
  protected readonly openNotes = signal<ReadonlySet<number>>(new Set());
  private readonly noteSources = new Map<number, NoteSource>();

  private readonly viewerZone = computed(() => viewerTimeZone(this.auth.me()));
  private readonly showZone = computed(() => differentZones(this.viewerZone(), this.timezone()));

  protected readonly upcoming = computed(() =>
    (this.sessions() ?? []).filter((s) => Date.parse(s.startsAt) > this.now()),
  );
  /** Минулі — від найновішої. */
  protected readonly past = computed(() =>
    (this.sessions() ?? []).filter((s) => Date.parse(s.startsAt) <= this.now()).reverse(),
  );

  constructor() {
    effect(() => {
      const id = this.gameId();
      untracked(() => void this.load(id));
    });
    const clock = setInterval(() => this.now.set(Date.now()), CLOCK_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(clock));
  }

  /** Розгорнути/згорнути приватну нотатку сесії (лише учасникам і майстру — як і сам список). */
  protected toggleNote(s: SessionDto): void {
    this.openNotes.update((open) => {
      const next = new Set(open);
      if (!next.delete(s.id)) next.add(s.id);
      return next;
    });
  }

  /** Джерело нотатки сесії — одне на сесію, щоб редактор не перечитував її. */
  protected noteSource(s: SessionDto): NoteSource {
    let source = this.noteSources.get(s.id);
    if (!source) {
      source = this.notes.sessionPrivate(s.id);
      this.noteSources.set(s.id, source);
    }
    return source;
  }

  /** Перезавантажити (після зміни правила розкладу на сторінці). */
  async reload(): Promise<void> {
    await this.load(this.gameId(), true);
  }

  protected when(s: SessionDto): string {
    return formatDateTime(s.startsAt, this.viewerZone(), { showZone: this.showZone() });
  }

  protected hours(s: SessionDto): number {
    return s.durationMinutes / 60;
  }

  /** Дії майстра над сесією: лише `scheduled`; завершити — коли вже почалась. */
  protected actions(s: SessionDto): SessionAction[] {
    if (!this.isGm() || !this.manageable() || s.status !== 'scheduled') return [];
    const list: SessionAction[] = ['reschedule', 'cancel'];
    if (Date.parse(s.startsAt) <= this.now()) list.push('finish');
    return list;
  }

  /**
   * Стан для підпису: заплановану, що вже почалась, показуємо як «очікує завершення», а якщо
   * гра вже не йде (завершити сесію не можна) — нейтрально «не завершена».
   */
  protected statusKey(s: SessionDto): string {
    if (s.status === 'scheduled' && Date.parse(s.startsAt) <= this.now()) {
      return this.manageable() ? 'sessions.status.awaiting' : 'sessions.status.unfinished';
    }
    return `sessions.status.${s.status}`;
  }

  /** Системна причина скасування (код) — ключ перекладу; причина майстра — як є. */
  protected systemReasonKey(reason: string): string | null {
    return (SYSTEM_CANCEL_REASONS as readonly string[]).includes(reason)
      ? `sessions.systemReason.${reason}`
      : null;
  }

  protected async run(s: SessionDto, action: SessionAction): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    try {
      const result = await firstValueFrom(this.openDialog(s, action).afterClosed());
      if (!result) return;
      // Завершення зсуває вікно матеріалізації — беремо список із сервера.
      await this.load(this.gameId(), true);
      this.message.set({ kind: 'info', key: `sessions.done.${action}` });
      this.changed.emit();
      this.focus(`[data-session-id="${s.id}"]`);
    } finally {
      this.busy.set(false);
    }
  }

  protected async retry(): Promise<void> {
    await this.load(this.gameId());
  }

  private openDialog(s: SessionDto, action: SessionAction) {
    const when = this.when(s);
    switch (action) {
      case 'reschedule':
        return this.dialog.open<RescheduleDialog, RescheduleDialogData, SessionDto>(
          RescheduleDialog,
          {
            ...DIALOG_OPTIONS,
            data: { session: s, timezone: this.timezone(), viewerTimezone: this.viewerZone() },
          },
        );
      case 'cancel':
        return this.dialog.open<CancelSessionDialog, CancelSessionDialogData, SessionDto>(
          CancelSessionDialog,
          { ...DIALOG_OPTIONS, data: { sessionId: s.id, when } },
        );
      case 'finish':
        return this.dialog.open<FinishSessionDialog, FinishSessionDialogData, SessionDto>(
          FinishSessionDialog,
          { ...DIALOG_OPTIONS, data: { sessionId: s.id, gameId: this.gameId(), when } },
        );
    }
  }

  private focus(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }

  private async load(gameId: number, silent = false): Promise<void> {
    if (!silent) this.loadFailed.set(false);
    try {
      const list = await firstValueFrom(this.api.list(gameId));
      this.now.set(Date.now());
      this.sessions.set(list);
    } catch (err) {
      const { code } = toApiError(err);
      if (code === 'UNAUTHENTICATED') return;
      if (silent) this.message.set({ kind: 'error', key: `errors.${code}` });
      else this.loadFailed.set(true);
    }
  }
}
