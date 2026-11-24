import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import type { UserStatus } from '@nri/shared';

export interface UserNameSource {
  nickname: string | null;
  status: UserStatus;
}

/** Ім'я користувача; видалений акаунт завжди показується як «Видалений користувач». */
@Component({
  selector: 'nri-user-name',
  imports: [TranslatePipe],
  templateUrl: './user-name.html',
  styleUrl: './user-name.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserName {
  readonly user = input.required<UserNameSource>();
}
