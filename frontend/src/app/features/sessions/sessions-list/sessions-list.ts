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
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { SESSION_RATING_WINDOW_DAYS, type RsvpStatus, type SessionDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { NotesApi, type NoteSource } from '../../../core/notes/notes.api';
import { formatDateTime, formatWindow, viewerTimeZone } from '../../../core/i18n/dates';
import { SessionsApi } from '../../../core/sessions/sessions.api';
import { changedKeys, Highlighter } from '../../../core/realtime/highlight';
import { ViewsService } from '../../../core/views/views.service';
import { NoteEditor } from '../../notes/note-editor/note-editor';
import {
  FinishSessionDialog,
  PIN_FIRST,
  type FinishSessionDialogData,
  type FinishSessionResult,
} from '../finish-session-dialog/finish-session-dialog';
import {
  CancelSessionDialog,
  type CancelSessionDialogData,
} from '../session-actions/cancel-session-dialog';
import { RescheduleDialog, type RescheduleDialogData } from '../session-actions/reschedule-dialog';
import {
  SessionSummaryDialog,
  type SessionSummaryDialogData,
} from '../session-actions/session-summary-dialog';
import { openSessionAlternatives } from '../../scheduling/session-alternatives-dialog/open-session-alternatives';
import { openPinTime } from '../../scheduling/pin-time-dialog/open-pin-time';

/** Дія майстра над сесією; `pin` — «Уточнити час» сесії з приблизним часом. */
export type SessionAction = 'pin' | 'alternatives' | 'reschedule' | 'cancel' | 'finish';

/** Дія майстра над підсумком проведеної сесії. */
export type SummaryAction = 'edit' | 'send';

/** Підсумок, довший за це (символів чи рядків), згортається до 3 рядків. */
const SUMMARY_CLAMP_CHARS = 240;
const SUMMARY_CLAMP_LINES = 3;

interface Message {
  kind: 'error' | 'info';
  key: string;
}

const SESSION_RATING_WINDOW_MS = SESSION_RATING_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Як часто оновлюється «зараз» (межа майбутніх і минулих, «очікує завершення»), мс. */
const CLOCK_MS = 60_000;

/** Причини автоскасування сесій бекендом (`cancel_reason` — код, а не текст майстра). */
const SYSTEM_CANCEL_REASONS = [
  'game_finished',
  'game_cancelled',
  'rule_changed',
  'campaign_paused',
] as const;

const DIALOG_OPTIONS = {
  autoFocus: 'first-tabbable',
  restoreFocus: true,
  width: '560px',
  maxWidth: 'calc(100vw - 32px)',
} as const;

/**
 * Сесії гри (сторінка гри — майстру й активним учасникам): майбутні й минулі, статус,
 * позначка «перенесено», причина скасування, підсумок (довгий — згорнутий до 3 рядків; майстер
 * може його змінити й один раз надіслати учасникам). Час — у поясі глядача з назвою поясу,
 * якщо він відрізняється від поясу гри. Майстер (поки гра набирає чи йде) може перенести чи
 * скасувати заплановану сесію, а завершити — лише ту, що вже почалась.
 */
@Component({
  selector: 'nri-sessions-list',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    MatButtonModule,
    MatIconModule,
    TranslatePipe,
    NoteEditor,
  ],
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
  /** Кампанія: після проведеної сесії її учасників можна оцінити (ваншот — лише підсумково). */
  readonly rateable = input(false);
  /** Сесії змінились — сторінці варто оновити «найближчу сесію». */
  readonly changed = output<void>();
  /** Глядач сам змінив дані (RSVP) — власний пінг не має піднімати банер. */
  readonly mutated = output<void>();

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
  /** Бейджі «Нове/Оновлено» — лише учасникам (сесії створює майстер). */
  private readonly seen = inject(ViewsService).tracker('session');
  protected readonly flash = new Highlighter<number>();
  /** Сесія, RSVP якої зберігається. */
  protected readonly rsvpBusy = signal<number | null>(null);
  /** Розгорнуті списки учасників у зведенні RSVP (майстер). */
  protected readonly openSummaries = signal<ReadonlySet<number>>(new Set());
  protected readonly rsvpStatuses: readonly RsvpStatus[] = ['going', 'not_going'];
  /** Розгорнуті довгі підсумки. */
  protected readonly openSummaryTexts = signal<ReadonlySet<number>>(new Set());

  private readonly viewerZone = computed(() => viewerTimeZone(this.auth.me()));

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
    inject(DestroyRef).onDestroy(() => {
      clearInterval(clock);
      this.flash.dispose();
    });
  }

  protected badge(s: SessionDto) {
    return this.isGm() ? null : this.seen.badge(s.id);
  }

  /** RSVP — учаснику (не майстру) на заплановану майбутню сесію. */
  protected canRsvp(s: SessionDto): boolean {
    return !this.isGm() && s.status === 'scheduled' && Date.parse(s.startsAt) > this.now();
  }

  /** Зведення RSVP майстру — на заплановані майбутні. */
  protected summaryFor(s: SessionDto) {
    return this.isGm() && s.status === 'scheduled' && Date.parse(s.startsAt) > this.now()
      ? s.rsvpSummary
      : null;
  }

  protected noAnswer(s: SessionDto): number {
    const sum = s.rsvpSummary;
    return sum ? sum.members.filter((m) => m.status === null).length : 0;
  }

  protected toggleSummary(s: SessionDto): void {
    this.openSummaries.update((open) => {
      const next = new Set(open);
      if (!next.delete(s.id)) next.add(s.id);
      return next;
    });
  }

  /** Довгий підсумок показуємо згорнутим до 3 рядків із «Показати повністю». */
  protected isLongSummary(s: SessionDto): boolean {
    const text = s.summary ?? '';
    return text.length > SUMMARY_CLAMP_CHARS || text.split('\n').length > SUMMARY_CLAMP_LINES;
  }

  protected toggleSummaryText(s: SessionDto): void {
    this.openSummaryTexts.update((open) => {
      const next = new Set(open);
      if (!next.delete(s.id)) next.add(s.id);
      return next;
    });
  }

  /**
   * Підсумок проведеної сесії майстру: змінити (чи додати) — завжди, навіть після завершення
   * гри; надіслати учасникам — один раз і лише непорожній.
   */
  protected summaryActions(s: SessionDto): SummaryAction[] {
    if (!this.isGm() || s.status !== 'done') return [];
    return s.summary && !s.summarySentAt ? ['edit', 'send'] : ['edit'];
  }

  /** «Надіслано <дата>» — майстру, після надсилання підсумку. */
  protected sentWhen(s: SessionDto): string | null {
    return this.isGm() && s.summarySentAt
      ? formatDateTime(s.summarySentAt, this.viewerZone())
      : null;
  }

  protected async runSummary(s: SessionDto, action: SummaryAction): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    try {
      const dto =
        action === 'edit'
          ? await firstValueFrom(
              this.dialog
                .open<SessionSummaryDialog, SessionSummaryDialogData, SessionDto>(
                  SessionSummaryDialog,
                  {
                    ...DIALOG_OPTIONS,
                    data: {
                      sessionId: s.id,
                      when: this.when(s),
                      summary: s.summary,
                      sent: s.summarySentAt !== null,
                    },
                  },
                )
                .afterClosed(),
            )
          : await firstValueFrom(this.api.sendSummary(s.id));
      if (!dto) return;
      // Власна зміна: пінг сесій від неї не має піднімати банер оновлень.
      this.mutated.emit();
      this.patch(s.id, dto);
      this.message.set({
        kind: 'info',
        key: action === 'edit' ? 'sessions.done.summary' : 'sessions.done.summarySent',
      });
    } catch (err) {
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') this.message.set({ kind: 'error', key: `errors.${code}` });
    } finally {
      this.busy.set(false);
    }
  }

  /** Оптимістично: показуємо вибір одразу, при помилці — повертаємо попередній. */
  protected async rsvp(s: SessionDto, status: RsvpStatus): Promise<void> {
    if (this.rsvpBusy() !== null || s.myRsvp === status) return;
    const previous = s.myRsvp;
    this.rsvpBusy.set(s.id);
    this.message.set(null);
    this.patch(s.id, { myRsvp: status });
    this.mutated.emit();
    try {
      const dto = await firstValueFrom(this.api.rsvp(s.id, status));
      // Ще раз: пінг міг прийти вже після вікна тиші, відкритого до запиту.
      this.mutated.emit();
      this.patch(s.id, dto);
      this.message.set({ kind: 'info', key: `sessions.rsvp.saved.${status}` });
    } catch (err) {
      this.patch(s.id, { myRsvp: previous });
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') this.message.set({ kind: 'error', key: `errors.${code}` });
    } finally {
      this.rsvpBusy.set(null);
    }
  }

  private patch(id: number, patch: Partial<SessionDto>): void {
    this.sessions.update(
      (list) => list?.map((x) => (x.id === id ? { ...x, ...patch } : x)) ?? list,
    );
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

  /**
   * Перезавантажити (після зміни правила розкладу чи за банером оновлень). `highlight` —
   * підсвітити сесії, що зʼявились або змінились.
   */
  async reload(highlight = false): Promise<boolean> {
    const before = this.sessions();
    const ok = await this.load(this.gameId(), true);
    const after = this.sessions();
    if (highlight && ok && after && after !== before) {
      this.flash.flash(changedKeys(before, after, (x) => x.id));
    }
    return ok;
  }

  /** Точний час або вікно початку («5 груд. 2026 р., 18:00–21:00»). */
  protected when(s: SessionDto): string {
    return formatWindow(s.startsAt, s.startWindowMinutes, this.viewerZone());
  }

  /** Час ще приблизний (вікно) — позначка «час уточнюється» на запланованій сесії. */
  protected approximate(s: SessionDto): boolean {
    return s.status === 'scheduled' && s.startWindowMinutes !== null;
  }

  protected hours(s: SessionDto): number {
    return s.durationMinutes / 60;
  }

  /**
   * «Оцінити» — на проведеній сесії кампанії, поки не минуло 14 днів від завершення. Кого
   * саме (й чи був глядач присутній) вирішує сервер на сторінці оцінювання — без запиту
   * на кожну сесію тут.
   */
  protected canRate(s: SessionDto): boolean {
    if (!this.rateable() || s.status !== 'done') return false;
    // Старі записи без `doneAt` — від початку сесії (сервер усе одно перевірить вікно).
    return this.now() - Date.parse(s.doneAt ?? s.startsAt) <= SESSION_RATING_WINDOW_MS;
  }

  /**
   * Дії майстра над сесією: лише `scheduled`; завершити — коли вже почалась. Сесії з
   * приблизним часом — спершу «Уточнити час» (без нього не почати гру й не завершити сесію).
   */
  protected actions(s: SessionDto): SessionAction[] {
    if (!this.isGm() || !this.manageable() || s.status !== 'scheduled') return [];
    const started = Date.parse(s.startsAt) <= this.now();
    // «Інший час» — підбір альтернатив у ±3 доби (лише для майбутньої сесії).
    const list: SessionAction[] = started
      ? ['reschedule', 'cancel', 'finish']
      : ['alternatives', 'reschedule', 'cancel'];
    return s.startWindowMinutes !== null ? ['pin', ...list] : list;
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
      let done: string = action === 'alternatives' ? 'reschedule' : action;
      let result =
        action === 'alternatives'
          ? await openSessionAlternatives(this.dialog, {
              sessionId: s.id,
              viewerTimezone: this.viewerZone(),
            })
          : action === 'pin'
            ? await this.pin(s.id)
            : await firstValueFrom(this.openDialog(s, action).afterClosed());
      // «Завершити» відмовило (409 SESSION_TIME_APPROXIMATE): майстер обрав «Уточнити час».
      if (result === PIN_FIRST) {
        result = await this.pin(s.id);
        done = 'pin';
      }
      if (!result) return;
      // Завершення зсуває вікно матеріалізації — беремо список із сервера.
      await this.load(this.gameId(), true);
      this.message.set({ kind: 'info', key: `sessions.done.${done}` });
      this.changed.emit();
      this.focus(`[data-session-id="${s.id}"]`);
    } finally {
      this.busy.set(false);
    }
  }

  protected async retry(): Promise<void> {
    await this.load(this.gameId());
  }

  private pin(sessionId: number): Promise<SessionDto | null> {
    return openPinTime(this.dialog, { sessionId, viewerTimezone: this.viewerZone() });
  }

  private openDialog(s: SessionDto, action: Exclude<SessionAction, 'alternatives' | 'pin'>) {
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
        return this.dialog.open<FinishSessionDialog, FinishSessionDialogData, FinishSessionResult>(
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

  private async load(gameId: number, silent = false): Promise<boolean> {
    if (!silent) this.loadFailed.set(false);
    try {
      const list = await firstValueFrom(this.api.list(gameId));
      this.now.set(Date.now());
      this.sessions.set(list);
      if (!this.isGm()) this.seen.track(list);
      return true;
    } catch (err) {
      const { code } = toApiError(err);
      if (code === 'UNAUTHENTICATED') return false;
      if (silent) this.message.set({ kind: 'error', key: `errors.${code}` });
      else this.loadFailed.set(true);
      return false;
    }
  }
}
