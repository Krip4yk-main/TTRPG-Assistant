import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Shell } from './layout/shell/shell';

@Component({
  selector: 'nri-root',
  imports: [Shell],
  templateUrl: './app.html',
  styleUrl: './app.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {}
