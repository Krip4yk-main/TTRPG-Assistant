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
import { GamesApi } from '../../../core/games/games.api';
import { formatDateTime, viewerTimeZone } from '../../../core/i18n/dates';
import { PendingRatingsStore } from '../../../core/ratings/pending-ratings.store';
import { RatingsApi } from '../../../core/ratings/ratings.api';
import { SessionsApi } from '../../../core/sessions/sessions.api';
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
  private readonly games = inject(GamesApi);
  private readonly sessions = inject(SessionsApi);
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
  protected readonly title = signal<string | null>(null);
  protected readonly sessionWhen = signal<string | null>(null);
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
    this.title.set(null);
    this.sessionWhen.set(null);
    if (!Number.isInteger(gameId) || gameId <= 0 || Number.isNaN(sessionId)) {
      this.state.set('notFound');
      return;
    }
    void this.loadTitle(seq, gameId, sessionId);
    try {
      await this.loadTargets(seq, gameId, sessionId);
    } catch (err) {
      if (seq !== this.seq) return;
      const { status, code } = toApiError(err);
      if (code === 'UNAUTHENTICATED') return;
      if (status === 404 || code === 'VALIDATION') this.state.set('notFound');
      else if (code === 'RATING_NOT_ALLOWED') this.state.set('forbidden');
      else this.state.set('error');
    }
  }

  private async loadTargets(seq: number, gameId: number, sessionId: number | null): Promise<void> {
    const dto = await firstValueFrom(this.api.targets(gameId, sessionId ?? undefined));
    if (seq !== this.seq) return;
    this.data.set(dto);
    this.state.set('ready');
  }

  /** Назва гри й дата сесії — лише для заголовка; збій не заважає оцінювати. */
  private async loadTitle(seq: number, gameId: number, sessionId: number | null): Promise<void> {
    const tz = viewerTimeZone(this.auth.me());
    const title = firstValueFrom(this.games.get(gameId)).then(
      (g) => {
        if (seq === this.seq) this.title.set(g.title);
      },
      () => undefined,
    );
    const when =
      sessionId === null
        ? Promise.resolve()
        : firstValueFrom(this.sessions.list(gameId)).then(
            (list) => {
              const s = list.find((x) => x.id === sessionId);
              if (s && seq === this.seq) this.sessionWhen.set(formatDateTime(s.startsAt, tz));
            },
            () => undefined,
          );
    await Promise.all([title, when]);
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
    } catch {
      // Лишаємо як було: причину конфлікту все одно показуємо нижче.
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
