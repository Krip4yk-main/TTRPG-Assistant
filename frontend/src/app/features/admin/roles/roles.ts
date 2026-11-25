import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { TranslatePipe } from '@ngx-translate/core';
import type { AdminUserDto, AdminUserListItemDto, AssignableRole, UserRole } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { canActOn } from '../../../core/auth/roles';
import { AdminApi } from '../../../core/moderation/admin.api';
import {
  OwnerTransferDialog,
  type OwnerTransferDialogData,
} from '../owner-transfer-dialog/owner-transfer-dialog';
import { Paged } from '../paged';
import { AdminPager } from '../pager/pager';

/**
 * Ролі, які `actor` може призначити людині з роллю `target` (як матриця бекенду): лише людині з
 * нижчою роллю; модератора — адмін і власник; адміна — лише власник. Порожньо — змінити не можна.
 */
export function assignableRoles(actor: UserRole | undefined, target: UserRole): AssignableRole[] {
  if (!actor || !canActOn(actor, target)) return [];
  if (actor === 'owner') return ['user', 'moderator', 'admin'];
  if (actor === 'admin') return ['user', 'moderator'];
  return [];
}

/**
 * «Ролі» (адмін і власник): пошук людини й зміна ролі за матрицею; власник може передати свої
 * права чинному адміну (діалог із введенням ніку). Після передачі власник стає адміном —
 * стан сесії перечитується.
 */
@Component({
  selector: 'nri-admin-roles',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    TranslatePipe,
    AdminPager,
  ],
  templateUrl: './roles.html',
  styleUrls: ['../admin-list.less', './roles.less'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminRoles {
  private readonly api = inject(AdminApi);
  private readonly auth = inject(AuthStore);
  private readonly dialog = inject(MatDialog);

  protected readonly myRole = computed(() => this.auth.me()?.role);
  protected readonly isOwner = computed(() => this.myRole() === 'owner');

  protected readonly query = new FormControl('', { nonNullable: true });
  protected readonly form = new FormGroup({ q: this.query });
  private readonly q = signal('');
  protected readonly list = new Paged<AdminUserListItemDto>(
    (cursor) => this.api.users(this.q(), cursor),
    (u) => u.publicId,
  );

  /** Обрана в списку роль за `publicId` (ще не збережена). */
  protected readonly picked = signal<Readonly<Record<string, AssignableRole>>>({});
  protected readonly busy = signal<string | null>(null);
  /** Результат дії: ключ i18n і рядок, до якого він стосується. */
  protected readonly notice = signal<{ publicId: string; key: string; error: boolean } | null>(
    null,
  );

  /** Список з'являється після першого пошуку (до того — підказка). */
  protected readonly searched = signal(false);

  protected search(): void {
    this.searched.set(true);
    this.q.set(this.query.value.trim());
    this.picked.set({});
    this.notice.set(null);
    void this.list.reload();
  }

  protected options(u: AdminUserListItemDto): AssignableRole[] {
    return u.status === 'active' ? assignableRoles(this.myRole(), u.role) : [];
  }

  protected selected(u: AdminUserListItemDto): UserRole {
    return this.picked()[u.publicId] ?? u.role;
  }

  protected pick(u: AdminUserListItemDto, role: AssignableRole): void {
    this.picked.update((p) => ({ ...p, [u.publicId]: role }));
  }

  protected async save(u: AdminUserListItemDto): Promise<void> {
    const role = this.picked()[u.publicId];
    if (!role || role === u.role || this.busy()) return;
    this.busy.set(u.publicId);
    this.notice.set(null);
    try {
      const card = await firstValueFrom(this.api.setRole(u.publicId, role));
      this.applyCard(u, card);
      this.notice.set({ publicId: u.publicId, key: 'admin.roles.saved', error: false });
    } catch (err) {
      const { code } = toApiError(err);
      this.notice.set({ publicId: u.publicId, key: `errors.${code}`, error: true });
    } finally {
      this.busy.set(null);
    }
  }

  protected async transfer(u: AdminUserListItemDto): Promise<void> {
    if (!this.isOwner() || u.role !== 'admin' || !u.nickname) return;
    const ref = this.dialog.open<OwnerTransferDialog, OwnerTransferDialogData, AdminUserDto>(
      OwnerTransferDialog,
      {
        data: { publicId: u.publicId, nickname: u.nickname },
        autoFocus: 'first-tabbable',
        restoreFocus: true,
        width: '560px',
        maxWidth: 'calc(100vw - 32px)',
      },
    );
    const card = await firstValueFrom(ref.afterClosed());
    if (!card) return;
    // Тепер я — адміністратор: перечитуємо сесію (вкладки й права) і список.
    await this.auth.load();
    this.picked.set({});
    this.notice.set({ publicId: u.publicId, key: 'admin.transfer.done', error: false });
    await this.list.reload();
  }

  private applyCard(u: AdminUserListItemDto, card: AdminUserDto): void {
    this.list.replace({ ...u, role: card.role });
    this.picked.update((p) => {
      const next = { ...p };
      delete next[u.publicId];
      return next;
    });
  }
}
