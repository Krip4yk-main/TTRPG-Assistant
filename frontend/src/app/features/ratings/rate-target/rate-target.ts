import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import {
  RATING_COMMENT_MAX,
  criteriaForRole,
  type ErrorCode,
  type RatingCriterion,
  type RatingInput,
  type RatingTargetDto,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { viewerTimeZone } from '../../../core/i18n/dates';
import { RatingsApi } from '../../../core/ratings/ratings.api';
import { formatDeadline } from '../../../core/ratings/rating-format';
import {
  ConfirmDialog,
  type ConfirmDialogData,
} from '../../../shared/confirm-dialog/confirm-dialog';
import { StarRating } from '../star-rating/star-rating';

/** Помилки, після яких стан цілі на сервері інший, ніж на сторінці: сторінка перечитує цілі. */
export const STALE_CODES: ReadonlySet<ErrorCode> = new Set([
  'RATING_EXISTS',
  'RATING_WINDOW_CLOSED',
  'RATING_NOT_ALLOWED',
]);

let nextId = 0;

/**
 * Форма оцінки однієї людини: загальна (обов'язкова), критерії за роллю цілі (кожен — за
 * бажанням, зі «скинути»), текст для адміністрації, «Надіслати» й «Відмовитись»
 * (з підтвердженням). Оцінена чи відхилена ціль — компактний рядок зі станом.
 */
@Component({
  selector: 'nri-rate-target',
  imports: [
    RouterLink,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    TranslatePipe,
    StarRating,
  ],
  templateUrl: './rate-target.html',
  styleUrl: './rate-target.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RateTarget {
  private readonly api = inject(RatingsApi);
  private readonly auth = inject(AuthStore);
  private readonly dialog = inject(MatDialog);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly target = input.required<RatingTargetDto>();
  readonly gameId = input.required<number>();
  /** Сесійна оцінка; `null` — підсумкова. */
  readonly sessionId = input<number | null>(null);
  /** Оцінку збережено (ціль у новому стані). */
  readonly submitted = output<RatingTargetDto>();
  /** Сервер відповів, що стан цілі вже інший (див. `STALE_CODES`). */
  readonly stale = output<ErrorCode>();

  protected readonly ids = (() => {
    const p = `rate-${++nextId}`;
    return {
      name: `${p}-name`,
      overall: `${p}-overall`,
      overallError: `${p}-overall-error`,
      warning: `${p}-warning`,
    };
  })();
  protected readonly commentMax = RATING_COMMENT_MAX;

  protected readonly overall = signal<number | null>(null);
  protected readonly scores = signal<Partial<Record<RatingCriterion, number>>>({});
  protected readonly comment = signal('');
  protected readonly busy = signal(false);
  protected readonly tried = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly criteria = computed(() => criteriaForRole(this.target().role));
  protected readonly missingOverall = computed(() => this.tried() && this.overall() === null);
  protected readonly name = computed(() => this.target().nickname);
  protected readonly closes = computed(() => {
    const iso = this.target().closesAt;
    return iso ? formatDeadline(iso, viewerTimeZone(this.auth.me())) : null;
  });

  protected criterionId(c: RatingCriterion): string {
    return `${this.ids.name}-${c}`;
  }

  protected setScore(c: RatingCriterion, value: number | null): void {
    this.scores.update((s) => {
      const next = { ...s };
      if (value === null) delete next[c];
      else next[c] = value;
      return next;
    });
  }

  protected resetScore(c: RatingCriterion): void {
    this.setScore(c, null);
    this.focus(`[data-criterion="${c}"] [role="radio"][tabindex="0"]`);
  }

  protected onComment(event: Event): void {
    this.comment.set((event.target as HTMLTextAreaElement).value);
  }

  protected async send(): Promise<void> {
    if (this.busy()) return;
    this.tried.set(true);
    const overall = this.overall();
    if (overall === null) {
      this.focus('.overall [role="radio"][tabindex="0"]');
      return;
    }
    const scores = this.scores();
    const comment = this.comment().trim();
    const input: RatingInput = {
      ...this.base(),
      overall,
      ...(Object.keys(scores).length ? { criteria: scores } : {}),
      ...(comment ? { comment } : {}),
    };
    await this.post(input, 'button.send');
  }

  protected async decline(): Promise<void> {
    if (this.busy()) return;
    const ref = this.dialog.open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
      data: {
        title: 'ratings.decline.title',
        text: 'ratings.decline.text',
        confirm: 'ratings.decline.confirm',
        params: { name: this.name() },
      },
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    if (!(await firstValueFrom(ref.afterClosed()))) return;
    await this.post({ ...this.base(), declined: true }, 'button.decline');
  }

  private base(): { rateeId: string; sessionId?: number } {
    const sessionId = this.sessionId();
    return {
      rateeId: this.target().publicId,
      ...(sessionId === null ? {} : { sessionId }),
    };
  }

  /** `returnFocus` — кнопка, на яку повернути фокус після помилки (вона була вимкнена). */
  private async post(input: RatingInput, returnFocus: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const saved = await firstValueFrom(this.api.submit(this.gameId(), input));
      this.submitted.emit(saved);
    } catch (err) {
      const { code } = toApiError(err);
      if (code === 'UNAUTHENTICATED') return;
      if (STALE_CODES.has(code)) this.stale.emit(code);
      else {
        this.error.set(`errors.${code}`);
        this.focus(returnFocus);
      }
    } finally {
      this.busy.set(false);
    }
  }

  private focus(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }
}
