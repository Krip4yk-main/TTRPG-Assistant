import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { ErrorCode, RatingTargetDto, RatingTargetsDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { formatDateTime, viewerTimeZone } from '../../../core/i18n/dates';
import { PendingRatingsStore } from '../../../core/ratings/pending-ratings.store';
import { RatingsApi } from '../../../core/ratings/ratings.api';
import { RateTarget } from '../rate-target/rate-target';

interface Message {
  kind: 'error' | 'info';
  key: string;
  name?: string;
}

/** Розбір `?session=`: відсутній — `null`, некоректний — `NaN`. */
function parseSession(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : Number.NaN;
}

/**
 * Сторінка оцінювання (`/games/:id/rate`, `?session=` — після сесії): кого я можу оцінити
 * зараз (каже сервер), форма для кожної відкритої цілі, компактний стан для оцінених і
 * відхилених. Конфлікт із сервером (вже оцінено, вікно закрилось) — перечитати цілі.
 */
@Component({
  selector: 'nri-rate-page',
  imports: [RouterLink, MatButtonModule, MatIconModule, TranslatePipe, RateTarget],
  templateUrl: './rate-page.html',
  styleUrl: './rate-page.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RatePage {
  private readonly api = inject(RatingsApi);
  private readonly auth = inject(AuthStore);
  private readonly pending = inject(PendingRatingsStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** `:id` з маршруту. */
  readonly id = input.required<string>();
  /** `?session=` з адреси. */
  readonly session = input<string | undefined>(undefined);

  protected readonly gameId = computed(() => Number(this.id()));
  protected readonly sessionId = computed(() => parseSession(this.session()));

  protected readonly data = signal<RatingTargetsDto | null>(null);
  protected readonly state = signal<'loading' | 'ready' | 'notFound' | 'forbidden' | 'error'>(
    'loading',
  );
  protected readonly title = computed(() => this.data()?.gameTitle ?? null);
  protected readonly sessionWhen = computed(() => {
    const iso = this.data()?.sessionStartsAt;
    return iso ? formatDateTime(iso, viewerTimeZone(this.auth.me())) : null;
  });
  protected readonly message = signal<Message | null>(null);
  private seq = 0;

  protected readonly targets = computed(() => this.data()?.targets ?? []);
  protected readonly openCount = computed(
    () => this.targets().filter((t) => t.state === 'open').length,
  );

  constructor() {
    effect(() => {
      const gameId = this.gameId();
      const sessionId = this.sessionId();
      untracked(() => void this.load(gameId, sessionId));
    });
  }

  protected retry(): void {
    void this.load(this.gameId(), this.sessionId());
  }

  private async load(gameId: number, sessionId: number | null): Promise<void> {
    const seq = ++this.seq;
    this.state.set('loading');
    this.data.set(null);
    this.message.set(null);
    if (!Number.isInteger(gameId) || gameId <= 0 || Number.isNaN(sessionId)) {
      this.state.set('notFound');
      return;
    }
    try {
      await this.loadTargets(seq, gameId, sessionId);
    } catch (err) {
      if (seq !== this.seq) return;
      const state = this.failureState(err);
      if (state) this.state.set(state);
    }
  }

  /** Стан сторінки за помилкою читання цілей; `null` — сесію втрачено (нічого не міняємо). */
  private failureState(err: unknown): 'notFound' | 'forbidden' | 'error' | null {
    const { status, code } = toApiError(err);
    if (code === 'UNAUTHENTICATED') return null;
    if (status === 404 || code === 'VALIDATION') return 'notFound';
    if (code === 'RATING_NOT_ALLOWED') return 'forbidden';
    return 'error';
  }

  private async loadTargets(seq: number, gameId: number, sessionId: number | null): Promise<void> {
    const dto = await firstValueFrom(this.api.targets(gameId, sessionId ?? undefined));
    if (seq !== this.seq) return;
    this.data.set(dto);
    this.state.set('ready');
  }

  protected onSubmitted(saved: RatingTargetDto): void {
    this.data.update((d) =>
      d ? { ...d, targets: d.targets.map((t) => (t.publicId === saved.publicId ? saved : t)) } : d,
    );
    this.message.set({
      kind: 'info',
      key: saved.state === 'declined' ? 'ratings.page.declined' : 'ratings.page.sent',
      name: saved.nickname,
    });
    this.focusResult(saved.publicId);
    void this.pending.refresh();
  }

  /** Сервер каже, що стан уже інший: показати причину й актуальні цілі. */
  protected async onStale(code: ErrorCode, target: RatingTargetDto): Promise<void> {
    const seq = this.seq;
    try {
      await this.loadTargets(seq, this.gameId(), this.sessionId());
    } catch (err) {
      // Доступ зник (виключили, гру сховано) — показуємо це; інакше лишаємо список як був.
      const state = seq === this.seq ? this.failureState(err) : null;
      if (state === 'notFound' || state === 'forbidden') this.state.set(state);
    }
    if (seq !== this.seq) return;
    this.message.set({ kind: 'error', key: `errors.${code}` });
    this.focusResult(target.publicId);
    void this.pending.refresh();
  }

  /** Фокус — на стан оціненої цілі (форма зникла), інакше — на заголовок. */
  private focusResult(publicId: string): void {
    afterNextRender(
      () => {
        const root = this.host.nativeElement;
        const el =
          root.querySelector<HTMLElement>(`[data-target="${publicId}"] .result`) ??
          root.querySelector<HTMLElement>('h1');
        el?.focus();
      },
      { injector: this.injector },
    );
  }
}
