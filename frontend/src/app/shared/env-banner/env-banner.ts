import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { runtimeConfig } from '../../../environments/runtime-config';

/**
 * Помітна позначка «Тестове середовище» на dev-сервері: маленька фіксована плашка в куті,
 * що не зсуває вміст. Колір — контрастна пара токенів небезпеки (з системним запасним
 * варіантом), тож читається в усіх дизайнах. Поза dev нічого не рендерить.
 */
@Component({
  selector: 'nri-env-banner',
  imports: [TranslatePipe],
  templateUrl: './env-banner.html',
  styleUrl: './env-banner.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnvBanner {
  /** Середовище розгортання (за замовчуванням — з конфігу збірки). */
  readonly deployEnv = input<string>(runtimeConfig.deployEnv);
}
