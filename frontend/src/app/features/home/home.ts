import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

/** Заглушка головної; пошук ігор з'явиться в Плані 2. */
@Component({
  selector: 'nri-home',
  imports: [TranslatePipe],
  templateUrl: './home.html',
  styleUrl: './home.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {}
