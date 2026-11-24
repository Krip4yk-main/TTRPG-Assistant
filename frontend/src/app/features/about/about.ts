import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

/** Публічні контакти автора. `label` — відображуваний текст, `href` — посилання. */
const AUTHOR_LINKS = [
  { key: 'about.author.github', label: 'Krip4yk-main', href: 'https://github.com/Krip4yk-main' },
  {
    key: 'about.author.email',
    label: 'krip4yk.main@gmail.com',
    href: 'mailto:krip4yk.main@gmail.com',
  },
  { key: 'about.author.telegram', label: '@krip4yk', href: 'https://t.me/krip4yk' },
  {
    key: 'about.author.linkedin',
    label: 'Viacheslav Mykhalchenko',
    href: 'https://www.linkedin.com/in/viacheslav-mykhalchenko-752042171/',
  },
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
