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
import type { NoteSource } from '../../../core/notes/notes.api';

/** Пауза після введення до автозбереження, мс. */
export const NOTE_AUTOSAVE_MS = 1000;
/** Лічильник символів з'являється, коли до межі лишається менше 10 %. */
const COUNTER_FROM = Math.floor(NOTE_BODY_MAX * 0.9);

type Status = 'loading' | 'loadError' | 'idle' | 'saving' | 'saved' | 'conflict' | 'error';

let nextId = 0;

/**
 * Текстова нотатка з автозбереженням (простий текст із переносами рядків, ≤ 200 000 символів).
 *
 * - Зберігає через 1 с після останнього введення, а також при втраті фокуса й знищенні
 *   компонента; незмінений текст не надсилає.
 * - Оптимістичне блокування: `PUT { body, version }`; на 409 `NOTE_CONFLICT` показує обидві
 *   версії — «Залишити мою» (повторний `PUT` з актуальною `version`) чи «Взяти актуальну».
 *   Поки конфлікт не вирішено, автозбереження зупинене.
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
  private inFlight = false;
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      void this.flush();
    });
  }

  ngOnInit(): void {
    const initial = this.initial();
    if (initial) this.apply(initial);
    else void this.load();
  }

  protected async load(): Promise<void> {
    this.status.set('loading');
    try {
      this.apply(await firstValueFrom(this.source().load()));
    } catch {
      if (!this.destroyed) this.status.set('loadError');
    }
  }

  protected onInput(value: string): void {
    this.body.set(value);
    if (this.conflict()) return;
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
    this.conflict.set(null);
    await this.flush();
    // Текст збігся з актуальним — зберігати нічого, але стан узгоджено.
    if (this.status() === 'conflict') this.status.set('saved');
  }

  /** «Взяти актуальну»: замінити свій текст версією з сервера. */
  protected takeTheirs(): void {
    const server = this.conflict();
    if (!server) return;
    this.conflict.set(null);
    this.apply({ ...server, updatedAt: null });
    this.status.set('saved');
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
    if (st === 'loading' || st === 'loadError') return;
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
    } catch (err) {
      const { code, details } = toApiError(err);
      if (code === 'NOTE_CONFLICT' && isConflict(details)) {
        this.conflict.set({ body: details.body, version: details.version });
        this.status.set('conflict');
      } else {
        this.status.set('error');
      }
    } finally {
      this.inFlight = false;
    }
    // Поки йшов запит, текст змінився — зберегти й це.
    if (!this.destroyed && this.status() === 'saved' && this.body() !== this.savedBody) {
      this.schedule();
    }
  }
}

function isConflict(d: unknown): d is NoteConflictDetails {
  const v = d as Partial<NoteConflictDetails> | null | undefined;
  return typeof v?.body === 'string' && typeof v.version === 'number';
}
