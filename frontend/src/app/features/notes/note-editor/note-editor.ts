import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
  type OnInit,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { NOTE_BODY_MAX, type NoteConflictDetails, type NoteDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import {
  noteDraftKey,
  readNoteDraft,
  removeNoteDraft,
  writeNoteDraft,
} from '../../../core/notes/note-draft-storage';
import type { NoteSource } from '../../../core/notes/notes.api';

/** Пауза після введення до автозбереження, мс. */
export const NOTE_AUTOSAVE_MS = 1000;
/** Пауза запису локальної копії, поки відкрито конфлікт, мс. */
export const NOTE_DRAFT_WRITE_MS = 500;
/** Лічильник символів з'являється, коли до межі лишається менше 10 %. */
const COUNTER_FROM = Math.floor(NOTE_BODY_MAX * 0.9);

/** `gone` — нотатки більше немає куди зберегти (404: сесію видалено); текст лише для копіювання. */
type Status = 'loading' | 'loadError' | 'idle' | 'saving' | 'saved' | 'conflict' | 'error' | 'gone';

let nextId = 0;

/**
 * Текстова нотатка з автозбереженням (простий текст із переносами рядків, ≤ 200 000 символів).
 *
 * - Зберігає через 1 с після останнього введення, а також при втраті фокуса й знищенні
 *   компонента; незмінений текст не надсилає.
 * - Оптимістичне блокування: `PUT { body, version }`; на 409 `NOTE_CONFLICT` показує обидві
 *   версії — «Залишити мою» (повторний `PUT` з актуальною `version`) чи «Взяти актуальну».
 *   Поки конфлікт не вирішено, автозбереження зупинене.
 * - Текст, який не вдалося зберегти (конфлікт чи помилка), копіюється в `localStorage`;
 *   при наступному відкритті редактор перечитує актуальну версію й знову показує вибір.
 * - При закритті сторінки (`pagehide`) відкладене збереження йде `fetch` з `keepalive`.
 * - 404 (сесію видалено) — локальна копія видаляється (її вже нікуди відновити), а текст
 *   лишається на екрані лише для читання, щоб його можна було скопіювати.
 * - `source` читається один раз (при створенні); `initial` — уже завантажена нотатка.
 */
@Component({
  selector: 'nri-note-editor',
  imports: [MatButtonModule, MatIconModule, TranslatePipe],
  templateUrl: './note-editor.html',
  styleUrl: './note-editor.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NoteEditor implements OnInit {
  private readonly auth = inject(AuthStore);

  readonly source = input.required<NoteSource>();
  /** Ключ i18n підпису поля. */
  readonly label = input.required<string>();
  /** Ключ i18n підказки під підписом. */
  readonly hint = input<string | null>(null);
  /** Уже завантажена нотатка — без окремого `GET`. */
  readonly initial = input<NoteDto | null>(null);
  /** Кількість рядків поля. */
  readonly rows = input(6);

  protected readonly uid = `nri-note-${nextId++}`;
  protected readonly max = NOTE_BODY_MAX;
  protected readonly status = signal<Status>('loading');
  protected readonly body = signal('');
  /** Конфлікт: актуальна версія з сервера. Мій текст — `body()`. */
  protected readonly conflict = signal<NoteConflictDetails | null>(null);
  protected readonly showCounter = computed(() => this.body().length >= COUNTER_FROM);

  /** Текст і версія, які сервер підтвердив останніми. */
  private savedBody = '';
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Відкладений запис локальної копії під час конфлікту. */
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private destroyed = false;
  private readonly onPageHide = () => this.flushOnPageHide();

  constructor() {
    window.addEventListener('pagehide', this.onPageHide);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('pagehide', this.onPageHide);
      this.destroyed = true;
      this.clearDraftTimer();
      if (this.conflict()) this.keepDraft();
      else void this.flush();
    });
  }

  ngOnInit(): void {
    const draft = this.readDraft();
    if (draft !== null) void this.restore(draft);
    else if (this.initial()) this.apply(this.initial()!);
    else void this.load();
  }

  /** «Спробувати ще раз» після збою завантаження: з локальною копією — знову відновлення. */
  protected retryLoad(): void {
    const draft = this.readDraft();
    if (draft !== null) void this.restore(draft);
    else void this.load();
  }

  private async load(): Promise<void> {
    this.status.set('loading');
    try {
      this.apply(await firstValueFrom(this.source().load()));
    } catch {
      if (!this.destroyed) this.status.set('loadError');
    }
  }

  protected onInput(value: string): void {
    if (this.status() === 'gone') return;
    this.body.set(value);
    if (this.conflict()) {
      this.scheduleDraft();
      return;
    }
    this.schedule();
  }

  protected onBlur(): void {
    void this.flush();
  }

  /** Повторити збереження після помилки. */
  protected retry(): void {
    void this.flush();
  }

  /** «Залишити мою»: перезаписати актуальну версію своїм текстом. */
  protected async keepMine(): Promise<void> {
    const server = this.conflict();
    if (!server) return;
    this.version = server.version;
    this.savedBody = server.body;
    this.clearDraftTimer();
    this.conflict.set(null);
    await this.flush();
    // Текст збігся з актуальним — зберігати нічого, але стан узгоджено.
    if (this.status() === 'conflict') {
      this.status.set('saved');
      this.dropDraft();
    }
  }

  /** «Взяти актуальну»: замінити свій текст версією з сервера. */
  protected takeTheirs(): void {
    const server = this.conflict();
    if (!server) return;
    this.clearDraftTimer();
    this.conflict.set(null);
    this.dropDraft();
    this.apply({ ...server, updatedAt: null });
    this.status.set('saved');
  }

  /** Ключ локальної копії незбереженого тексту (`null` — гість, копій не робимо). */
  private get draftKey(): string | null {
    const userId = this.auth.me()?.id;
    return userId ? noteDraftKey(userId, this.source().key) : null;
  }

  private readDraft(): string | null {
    const key = this.draftKey;
    return key ? readNoteDraft(key) : null;
  }

  private keepDraft(): void {
    const key = this.draftKey;
    if (key) writeNoteDraft(key, this.body());
  }

  /** Під час конфлікту копію пишемо не на кожне натискання, а з паузою. */
  private scheduleDraft(): void {
    this.clearDraftTimer();
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      this.keepDraft();
    }, NOTE_DRAFT_WRITE_MS);
  }

  private clearDraftTimer(): void {
    if (this.draftTimer !== null) clearTimeout(this.draftTimer);
    this.draftTimer = null;
  }

  private dropDraft(): void {
    const key = this.draftKey;
    if (key) removeNoteDraft(key);
  }

  /** Є незбережений текст із минулого разу: показати його поруч з актуальною версією. */
  private async restore(draft: string): Promise<void> {
    this.status.set('loading');
    try {
      const server = await firstValueFrom(this.source().load());
      this.apply(server);
      if (draft === server.body) {
        this.dropDraft();
        return;
      }
      this.body.set(draft);
      this.conflict.set({ body: server.body, version: server.version });
      this.status.set('conflict');
    } catch (err) {
      if (isGone(err)) {
        this.body.set(draft);
        this.markGone();
      } else if (!this.destroyed) this.status.set('loadError');
    }
  }

  /** Нотатки більше немає (404): копія недосяжна — видаляємо, текст лишається на екрані. */
  private markGone(): void {
    this.clearTimer();
    this.clearDraftTimer();
    this.dropDraft();
    this.status.set('gone');
  }

  private apply(note: NoteDto): void {
    this.savedBody = note.body;
    this.version = note.version;
    this.body.set(note.body);
    this.status.set('idle');
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => void this.flush(), NOTE_AUTOSAVE_MS);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Зберегти зараз, якщо є що зберігати. */
  private async flush(): Promise<void> {
    this.clearTimer();
    if (this.inFlight || this.conflict()) return;
    const st = this.status();
    if (st === 'loading' || st === 'loadError' || st === 'gone') return;
    const body = this.body();
    if (body === this.savedBody) {
      if (st === 'error') this.status.set('saved');
      return;
    }
    this.inFlight = true;
    this.status.set('saving');
    try {
      const saved = await firstValueFrom(this.source().save({ body, version: this.version }));
      this.savedBody = saved.body;
      this.version = saved.version;
      this.status.set('saved');
      this.dropDraft();
    } catch (err) {
      const { code, details } = toApiError(err);
      if (isGone(err)) {
        this.markGone();
        return;
      }
      if (code === 'NOTE_CONFLICT' && isConflict(details)) {
        this.conflict.set({ body: details.body, version: details.version });
        this.status.set('conflict');
      } else {
        this.status.set('error');
      }
      // Мій текст не збережено — копія, щоб не загубити його, якщо редактор закриють.
      this.keepDraft();
    } finally {
      this.inFlight = false;
    }
    // Поки йшов запит, текст змінився — зберегти й це (після знищення — одразу, один раз).
    if (this.status() === 'saved' && this.body() !== this.savedBody) {
      if (this.destroyed) void this.flush();
      else this.schedule();
    }
  }

  /**
   * Сторінку закривають/ховають: незбережене відкладене введення відправляємо `fetch` з
   * `keepalive` (звичайний запит браузер може обірвати).
   */
  private flushOnPageHide(): void {
    if (this.draftTimer !== null) {
      this.clearDraftTimer();
      this.keepDraft();
    }
    if (this.inFlight || this.conflict() || this.timer === null) return;
    const body = this.body();
    this.clearTimer();
    if (body === this.savedBody) return;
    this.keepDraft();
    try {
      void fetch(this.source().url, {
        method: 'PUT',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
        body: JSON.stringify({ body, version: this.version }),
      }).catch(() => undefined);
    } catch {
      // keepalive недоступний — копія в localStorage лишається.
    }
  }
}

/** Токен CSRF із куки (як `withXsrfConfiguration` для HttpClient). */
function csrfToken(): string {
  const match = /(?:^|;\s*)nri_csrf=([^;]*)/.exec(document.cookie);
  return match ? decodeURIComponent(match[1]!) : '';
}

/** 404: сесію (чи гру) нотатки видалено. */
function isGone(err: unknown): boolean {
  return toApiError(err).code === 'NOT_FOUND';
}

function isConflict(d: unknown): d is NoteConflictDetails {
  const v = d as Partial<NoteConflictDetails> | null | undefined;
  return typeof v?.body === 'string' && typeof v.version === 'number';
}
