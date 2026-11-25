import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { AdminUserDto, SanctionDto, SanctionType } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { canActOn, roleAtLeast } from '../../../core/auth/roles';
import { AdminApi } from '../../../core/moderation/admin.api';
import { AdminDatePipe } from '../admin-date.pipe';
import { openSanctionDialog, openTextDialog } from '../dialogs';
import { AdminUserRef } from '../user-ref/user-ref';

/**
 * Стан санкції для показу. Строк минув — задача ставить `liftedAt = endsAt` без діяча;
 * інакше знята людиною (достроково чи за апеляцією).
 */
export function sanctionState(s: SanctionDto): 'active' | 'lifted' | 'expired' {
  if (s.active) return 'active';
  if (s.liftedBy || (s.liftedAt && s.liftedAt !== s.endsAt)) return 'lifted';
  return 'expired';
}

/**
 * Картка користувача в адмінці: роль, статус, санкції (чинні й минулі, із зняттям) і скарги на
 * людину (скаржник прихований для модераторів). Накласти чи зняти санкцію можна лише людині з
 * нижчою роллю; бан і розбан — лише адміну й власнику; видаленому акаунту — лише бан.
 */
@Component({
  selector: 'nri-admin-user-card',
  imports: [RouterLink, MatButtonModule, MatIconModule, TranslatePipe, AdminDatePipe, AdminUserRef],
  templateUrl: './user-card.html',
  styleUrls: ['../admin-list.less', './user-card.less'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminUserCard {
  private readonly api = inject(AdminApi);
  private readonly auth = inject(AuthStore);
  private readonly dialog = inject(MatDialog);

  /** `:publicId` з маршруту. */
  readonly publicId = input.required<string>();

  protected readonly user = signal<AdminUserDto | null>(null);
  protected readonly state = signal<'loading' | 'ready' | 'notFound' | 'error'>('loading');
  protected readonly notice = signal<string | null>(null);
  private seq = 0;

  private readonly myRole = computed(() => this.auth.me()?.role ?? 'user');
  protected readonly isAdmin = computed(() => roleAtLeast(this.myRole(), 'admin'));
  /** Типи, які можна накласти цій людині (порожньо — кнопки немає). */
  protected readonly imposable = computed<readonly SanctionType[]>(() => {
    const u = this.user();
    if (!u || u.status === 'pending' || !canActOn(this.myRole(), u.role)) return [];
    if (u.status === 'deleted') return this.isAdmin() ? ['global_ban'] : [];
    return ['warning', 'application_limit', 'no_paid_apply', 'no_paid_create', 'global_ban'];
  });

  constructor() {
    effect(() => {
      const id = this.publicId();
      untracked(() => void this.load(id));
    });
  }

  protected readonly sanctionState = sanctionState;

  protected canLift(s: SanctionDto): boolean {
    const u = this.user();
    return (
      !!u &&
      s.active &&
      canActOn(this.myRole(), u.role) &&
      (s.type !== 'global_ban' || this.isAdmin())
    );
  }

  protected retry(): void {
    void this.load(this.publicId());
  }

  protected async impose(): Promise<void> {
    const u = this.user();
    const types = this.imposable();
    if (!u || !types.length) return;
    const saved = await openSanctionDialog<SanctionDto>(this.dialog, {
      name: u.nickname ?? u.publicId,
      actorRole: this.myRole(),
      types,
      submit: (input) => this.api.impose(u.publicId, input),
    });
    if (!saved) return;
    this.notice.set('admin.users.imposed');
    await this.load(u.publicId, true);
  }

  protected async lift(s: SanctionDto): Promise<void> {
    const u = this.user();
    if (!u) return;
    const saved = await openTextDialog<SanctionDto>(this.dialog, {
      title: 'admin.users.liftTitle',
      text: 'admin.users.liftText',
      label: 'admin.note',
      required: false,
      confirm: 'admin.users.lift',
      submit: (note) => this.api.lift(s.id, note),
    });
    if (!saved) return;
    this.notice.set('admin.users.lifted');
    await this.load(u.publicId, true);
  }

  private async load(publicId: string, silent = false): Promise<void> {
    const seq = ++this.seq;
    if (!silent) {
      this.state.set('loading');
      this.user.set(null);
      this.notice.set(null);
    }
    try {
      const u = await firstValueFrom(this.api.user(publicId));
      if (seq !== this.seq) return;
      this.user.set(u);
      this.state.set('ready');
    } catch (err) {
      if (seq !== this.seq) return;
      if (!silent) this.state.set(toApiError(err).status === 404 ? 'notFound' : 'error');
    }
  }
}
