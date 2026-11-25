import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';

/**
 * Банер «Є оновлення — оновити»: фіксований унизу вікна (поверх вмісту, не зсуває його).
 * Жива область присутня завжди, тож поява банера оголошується зчитувачам екрана.
 */
@Component({
  selector: 'nri-update-banner',
  imports: [MatButtonModule, MatIconModule, TranslatePipe],
  templateUrl: './update-banner.html',
  styleUrl: './update-banner.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UpdateBanner {
  readonly visible = input(false);
  /** Іде оновлення — кнопка вимкнена. */
  readonly busy = input(false);
  readonly refresh = output<void>();
}
