import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

/** Промо-картинка (ассети `assets/promo/`): WebP у двох розмірах і PNG-запасний варіант. */
export const SPONSORS_PROMO = {
  webpSrcset:
    'assets/promo/nri-promo-1920x1080.webp 1920w, assets/promo/nri-promo-3840x2160.webp 3840w',
  png: 'assets/promo/nri-promo-1920x1080.png',
  width: 1920,
  height: 1080,
  // Ширина вмісту сторінки — не більша за --nri-content-max-width (960px).
  sizes: '(min-width: 960px) 960px, 100vw',
} as const;

/** Контакт для спонсорів. */
export const SPONSORS_CONTACT = { label: 't.me/krip4yk', href: 'https://t.me/krip4yk' } as const;

/**
 * Сторінка для спонсорів. Зараз — лише промо й контакт; кожен блок — окрема `<section>`,
 * тож майбутні «План витрат на рік» і список спонсорів додаються поруч новими секціями.
 */
@Component({
  selector: 'nri-sponsors',
  imports: [TranslatePipe],
  templateUrl: './sponsors.html',
  styleUrl: './sponsors.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Sponsors {
  protected readonly promo = SPONSORS_PROMO;
  protected readonly contact = SPONSORS_CONTACT;
}
