import { ChangeDetectionStrategy, Component } from '@angular/core';
import { EnvBanner } from './shared/env-banner/env-banner';
import { TesterReport } from './shared/tester-report/tester-report';
import { Slot } from './theming/slot';

/** Корінь: каркас сторінки — слот `shell` чинного дизайну. */
@Component({
  selector: 'nri-root',
  imports: [Slot, EnvBanner, TesterReport],
  templateUrl: './app.html',
  styleUrl: './app.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {}
