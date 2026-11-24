import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

/** Кредити автора — плейсхолдери, як у README (заповнює власник). */
const AUTHOR_LINKS = [
  { key: 'about.author.github', value: '<GITHUB_URL>' },
  { key: 'about.author.email', value: '<EMAIL>' },
  { key: 'about.author.telegram', value: '<TELEGRAM>' },
  { key: 'about.author.linkedin', value: '<LINKEDIN>' },
] as const;

@Component({
  selector: 'nri-about',
  imports: [TranslatePipe],
  templateUrl: './about.html',
  styleUrl: './about.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class About {
  protected readonly authorLinks = AUTHOR_LINKS;
}
