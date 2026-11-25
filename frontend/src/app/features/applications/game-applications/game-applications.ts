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
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  APPLICATION_STATUSES,
  CONSTRAINT_COMMENT_MAX,
  CONSTRAINT_RESPONSES,
  isRestrictedGame,
  type ApplicationConstraintDto,
  type ApplicationDto,
  type ApplicationStatus,
  type ConstraintResponse,
  type GameApplicationDto,
  type PublicGameDto,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { ApplicationsApi } from '../../../core/applications/applications.api';
import { AuthStore } from '../../../core/auth/auth.store';
import { GamesApi } from '../../../core/games/games.api';
import { formatDateTime, viewerTimeZone } from '../../../core/i18n/dates';
import { MembersApi } from '../../../core/members/members.api';
import {
  ConfirmDialog,
  type ConfirmDialogData,
} from '../../../shared/confirm-dialog/confirm-dialog';

/** Повідомлення сторінки: ключ i18n. */
interface Message {
  kind: 'error' | 'info';
  key: string;
}

interface Group {
  status: ApplicationStatus;
  items: GameApplicationDto[];
}

/** Чернетка відповіді майстра на одне обмеження. */
interface Draft {
  response: ConstraintResponse | null;
  comment: string;
  error: string | null;
}

/** Обмеження можна відповідати до й після затвердження (як на бекенді). */
const EDITABLE = new Set<ApplicationStatus>(['pending', 'approved']);

const draftKey = (appId: number, cid: string) => `${appId}:${cid}`;

/**
 * Заявки на гру (`/games/:id/applications`, лише майстру): відповіді на анкету,
 * повідомлення й обмеження гравця; відповідь на кожне обмеження
 * (`accepted` / `partial` з коментарем / `cannot_guarantee`), «Затвердити» (з
 * попередженням, якщо гра вже заповнена) і «Відхилити» (з підтвердженням).
 */
@Component({
  selector: 'nri-game-applications',
  imports: [
    RouterLink,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatRadioModule,
    TranslatePipe,
  ],
  templateUrl: './game-applications.html',
  styleUrl: './game-applications.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameApplications {
  private readonly games = inject(GamesApi);
  private readonly api = inject(ApplicationsApi);
  private readonly members = inject(MembersApi);
  private readonly auth = inject(AuthStore);
  private readonly dialog = inject(MatDialog);
  private readonly translate = inject(TranslateService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** `:id` з маршруту. */
  readonly id = input.required<string>();

  protected readonly responses = CONSTRAINT_RESPONSES;
  protected readonly commentMax = CONSTRAINT_COMMENT_MAX;

  protected readonly game = signal<PublicGameDto | null>(null);
  protected readonly items = signal<GameApplicationDto[] | null>(null);
  protected readonly memberCount = signal(0);
  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly errorKey = signal<string | null>(null);
  protected readonly message = signal<Message | null>(null);
  /** Заявка, над якою триває дія (захист від подвійного кліку). */
  protected readonly busyId = signal<number | null>(null);
  protected readonly drafts = signal<Record<string, Draft>>({});

  /** Гра заповнена — затвердження піде понад максимум. */
  protected readonly full = computed(() => {
    const g = this.game();
    return !!g && this.memberCount() >= g.maxPlayers;
  });

  /** Непорожні групи в порядку `APPLICATION_STATUSES` (`pending` першими); старші — вище. */
  protected readonly groups = computed<Group[]>(() => {
    const list = this.items() ?? [];
    return APPLICATION_STATUSES.map((status) => ({
      status,
      items: list
        .filter((a) => a.status === status)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    })).filter((g) => g.items.length > 0);
  });

  constructor() {
    effect(() => {
      void this.load(Number(this.id()));
    });
  }

  protected async retry(): Promise<void> {
    await this.load(Number(this.id()));
  }

  protected canEdit(a: ApplicationDto): boolean {
    return EDITABLE.has(a.status);
  }

  /** Пари «питання — відповідь» (питання з гри; зайві відповіді — без питання). */
  protected qa(a: ApplicationDto): { question: string | null; answer: string }[] {
    const questions = this.game()?.applicationQuestions ?? [];
    return a.answers.map((answer, i) => ({ question: questions[i] ?? null, answer }));
  }

  protected when(iso: string): string {
    return formatDateTime(iso, viewerTimeZone(this.auth.me()));
  }

  protected draft(a: ApplicationDto, c: ApplicationConstraintDto): Draft {
    return (
      this.drafts()[draftKey(a.id, c.id)] ?? {
        response: c.response,
        comment: c.comment ?? '',
        error: null,
      }
    );
  }

  protected setResponse(a: ApplicationDto, c: ApplicationConstraintDto, value: unknown): void {
    this.patchDraft(a, c, { response: value as ConstraintResponse, error: null });
  }

  protected setComment(a: ApplicationDto, c: ApplicationConstraintDto, event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    this.patchDraft(a, c, { comment: value, error: null });
  }

  /** Зберегти відповідь; `partial` без коментаря — помилка біля поля, без запиту. */
  protected async saveConstraint(
    a: GameApplicationDto,
    c: ApplicationConstraintDto,
  ): Promise<void> {
    if (this.busyId() !== null) return;
    const d = this.draft(a, c);
    const comment = d.comment.trim();
    let error: string | null = null;
    if (!d.response) error = 'games.applications.gm.responseRequired';
    else if (d.response === 'partial' && !comment) {
      error = 'games.applications.gm.commentRequired';
    } else if (comment.length > CONSTRAINT_COMMENT_MAX) error = 'games.applications.gm.tooLong';
    if (error || !d.response) {
      this.patchDraft(a, c, { error });
      const target = d.response ? 'textarea' : 'input[type="radio"]';
      this.focus(`#c-${a.id}-${c.id} ${target}`);
      return;
    }
    this.busyId.set(a.id);
    this.message.set(null);
    try {
      const dto = await firstValueFrom(
        this.api.respond(a.id, c.id, { response: d.response, comment: comment || null }),
      );
      this.replace(dto);
      this.clearDraft(a, c);
      this.message.set({ kind: 'info', key: 'games.applications.gm.responseSaved' });
    } catch (err) {
      this.fail(err);
    } finally {
      this.busyId.set(null);
    }
  }

  /**
   * Затвердити. Якщо гра вже заповнена чи є незбережені відповіді на обмеження — спершу
   * одне підтвердження (про незбережені відповіді — окремим попередженням у ньому).
   */
  protected async approve(a: GameApplicationDto): Promise<void> {
    const g = this.game();
    if (!g || this.busyId() !== null) return;
    const unsaved = this.hasUnsaved(a);
    if (this.full()) {
      const ok = await this.confirm({
        title: 'games.applications.gm.confirmOverMax.title',
        text: 'games.applications.gm.confirmOverMax.text',
        confirm: 'games.applications.gm.confirmOverMax.confirm',
        params: { count: this.memberCount(), max: g.maxPlayers },
        ...(unsaved ? { note: 'games.applications.gm.unsavedNote' } : {}),
      });
      if (!ok) return;
    } else if (unsaved) {
      const ok = await this.confirm({
        title: 'games.applications.gm.confirmUnsaved.title',
        text: 'games.applications.gm.confirmUnsaved.text',
        confirm: 'games.applications.gm.confirmUnsaved.confirm',
      });
      if (!ok) return;
    }
    await this.decide(a, 'approve');
  }

  /** Є чернетки відповідей, що відрізняються від збережених. */
  private hasUnsaved(a: GameApplicationDto): boolean {
    const drafts = this.drafts();
    return a.constraints.some((c) => {
      const d = drafts[draftKey(a.id, c.id)];
      return !!d && (d.response !== c.response || d.comment.trim() !== (c.comment ?? '').trim());
    });
  }

  protected async reject(a: GameApplicationDto): Promise<void> {
    if (this.busyId() !== null) return;
    const ok = await this.confirm({
      title: 'games.applications.gm.confirmReject.title',
      text: 'games.applications.gm.confirmReject.text',
      confirm: 'games.applications.gm.confirmReject.confirm',
      params: { name: a.applicant.nickname ?? this.translate.instant('user.deleted') },
      danger: true,
    });
    if (ok) await this.decide(a, 'reject');
  }

  private async decide(a: GameApplicationDto, action: 'approve' | 'reject'): Promise<void> {
    this.busyId.set(a.id);
    this.message.set(null);
    // Картка переходить в іншу групу: фокус — на наступну заявку, що чекає, інакше на повідомлення.
    const waiting = this.groups().find((g) => g.status === 'pending')?.items ?? [];
    const index = waiting.findIndex((x) => x.id === a.id);
    const rest = waiting.filter((x) => x.id !== a.id);
    const next = rest[Math.min(index, rest.length - 1)];
    try {
      const dto = await firstValueFrom(
        action === 'approve' ? this.api.approve(a.id) : this.api.reject(a.id),
      );
      this.replace(dto);
      if (action === 'approve') this.memberCount.update((n) => n + 1);
      this.message.set({
        kind: 'info',
        key:
          action === 'approve'
            ? 'games.applications.gm.approved'
            : 'games.applications.gm.rejected',
      });
      this.focus(next ? `[data-application-id="${next.id}"]` : '.message-area');
    } catch (err) {
      this.fail(err);
    } finally {
      this.busyId.set(null);
    }
  }

  private async confirm(data: ConfirmDialogData): Promise<boolean> {
    const ref = this.dialog.open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
      data,
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    return !!(await firstValueFrom(ref.afterClosed()));
  }

  /** Помилка дії: текст в aria-live і тихе оновлення (стан заявки міг змінитись). */
  private fail(err: unknown): void {
    const { code } = toApiError(err);
    // 401 уже обробив authInterceptor.
    if (code === 'UNAUTHENTICATED') return;
    this.message.set({ kind: 'error', key: `errors.${code}` });
    void this.load(Number(this.id()), true);
  }

  private replace(dto: ApplicationDto): void {
    this.items.update((list) => (list ?? []).map((x) => (x.id === dto.id ? { ...x, ...dto } : x)));
  }

  private patchDraft(a: ApplicationDto, c: ApplicationConstraintDto, patch: Partial<Draft>): void {
    const key = draftKey(a.id, c.id);
    this.drafts.update((all) => ({ ...all, [key]: { ...this.draft(a, c), ...patch } }));
  }

  private clearDraft(a: ApplicationDto, c: ApplicationConstraintDto): void {
    const key = draftKey(a.id, c.id);
    this.drafts.update((all) => {
      const next = { ...all };
      delete next[key];
      return next;
    });
  }

  private focus(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }

  /** `silent` — оновити без стану «завантаження» (після помилки дії). */
  private async load(id: number, silent = false): Promise<void> {
    if (!silent) {
      this.state.set('loading');
      this.errorKey.set(null);
    }
    if (!Number.isInteger(id) || id <= 0) {
      this.state.set('error');
      this.errorKey.set('errors.NOT_FOUND');
      return;
    }
    try {
      const [game, items, members] = await Promise.all([
        firstValueFrom(this.games.get(id)),
        firstValueFrom(this.api.forGame(id)),
        firstValueFrom(this.members.list(id)),
      ]);
      this.game.set(isRestrictedGame(game) ? null : game);
      this.items.set(items);
      this.memberCount.set(members.length);
      this.state.set('ready');
    } catch (err) {
      const { code } = toApiError(err);
      if (code === 'UNAUTHENTICATED' || silent) return;
      this.errorKey.set(`errors.${code}`);
      this.state.set('error');
    }
  }
}
