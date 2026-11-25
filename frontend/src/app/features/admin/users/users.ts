import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import type { AdminUserListItemDto } from '@nri/shared';
import { AdminApi } from '../../../core/moderation/admin.api';
import { Paged } from '../paged';
import { AdminPager } from '../pager/pager';

/**
 * Пошук користувачів за початком ніку або точним `publicId`; рядок веде на картку
 * (`/admin/users/:publicId`). Порожній запит — усі за порядком реєстрації.
 */
@Component({
  selector: 'nri-admin-users',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    TranslatePipe,
    AdminPager,
  ],
  templateUrl: './users.html',
  styleUrls: ['../admin-list.less', './users.less'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminUsers {
  private readonly api = inject(AdminApi);

  protected readonly query = new FormControl('', { nonNullable: true });
  protected readonly form = new FormGroup({ q: this.query });
  private readonly q = signal('');
  protected readonly list = new Paged<AdminUserListItemDto>(
    (cursor) => this.api.users(this.q(), cursor),
    (u) => u.publicId,
  );

  constructor() {
    void this.list.reload();
  }

  protected search(): void {
    this.q.set(this.query.value.trim());
    void this.list.reload();
  }
}
