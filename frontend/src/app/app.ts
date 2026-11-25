import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Slot } from './theming/slot';

/** Корінь: каркас сторінки — слот `shell` чинного дизайну. */
@Component({
  selector: 'nri-root',
  imports: [Slot],
  templateUrl: './app.html',
  styleUrl: './app.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {}
