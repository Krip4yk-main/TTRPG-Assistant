import { DOCUMENT, Injectable, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { TranslateService } from '@ngx-translate/core';

/** Метадані сторінки. `title` — готовий текст, `titleKey` — ключ i18n (одне з двох). */
export interface SeoOptions {
  titleKey?: string;
  title?: string;
  description?: string | null;
  image?: string | null;
  /** Не індексувати сторінку (`<meta name="robots" content="noindex">`). */
  noindex?: boolean;
}

/**
 * Статичні метадані сторінки без даних (`data.seo` маршруту): опис — ключ i18n, картинка —
 * шлях від кореня сайту (в `og:image` стає абсолютним URL).
 */
export interface RouteSeo {
  descriptionKey: string;
  image?: string;
}

/** Найдовший опис у `meta[name=description]` / `og:description`. */
const MAX_DESCRIPTION = 200;

function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > MAX_DESCRIPTION ? `${t.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…` : t;
}

/**
 * Заголовок вкладки, опис, Open Graph і `robots` для сторінок з даними (гра, профіль).
 * Кожен виклик `set` описує сторінку повністю: не задане поле повертається до типового
 * (зокрема `noindex` прибирається). `reset` викликається при кожній навігації.
 */
@Injectable({ providedIn: 'root' })
export class SeoService {
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly translate = inject(TranslateService);
  private readonly document = inject(DOCUMENT);
  /** Опис з `index.html` — типовий для сторінок без власного. */
  private readonly defaultDescription = this.meta.getTag('name="description"')?.content ?? '';
  private seq = 0;

  set(options: SeoOptions): void {
    const seq = ++this.seq;
    const keys = options.titleKey ? ['app.title', options.titleKey] : ['app.title'];
    this.translate.get(keys).subscribe((t: Record<string, string>) => {
      // Пізніший виклик (наступна сторінка) не перезаписується відповіддю попереднього.
      if (seq !== this.seq) return;
      const app = t['app.title'] ?? '';
      const page = options.title ?? (options.titleKey ? t[options.titleKey] : undefined);
      this.title.setTitle(page && page !== app ? `${page} — ${app}` : app);
      this.meta.updateTag({ property: 'og:title', content: page || app });
    });

    const description = options.description?.trim()
      ? clip(options.description)
      : this.defaultDescription;
    this.meta.updateTag({ name: 'description', content: description });
    this.meta.updateTag({ property: 'og:description', content: description });
    this.meta.updateTag({ property: 'og:url', content: this.document.location?.href ?? '' });
    if (options.image) this.meta.updateTag({ property: 'og:image', content: options.image });
    else this.meta.removeTag("property='og:image'");
    if (options.noindex) this.meta.updateTag({ name: 'robots', content: 'noindex' });
    else this.meta.removeTag("name='robots'");
  }

  /** Типові метадані (заголовок ставить `TitleStrategy`). */
  reset(): void {
    this.seq++;
    this.meta.updateTag({ name: 'description', content: this.defaultDescription });
    for (const p of ['og:title', 'og:description', 'og:image', 'og:url']) {
      this.meta.removeTag(`property='${p}'`);
    }
    this.meta.removeTag("name='robots'");
  }

  /** Лише `noindex` (для маршрутів з `data.noindex`, після `reset`). */
  noindex(): void {
    this.meta.updateTag({ name: 'robots', content: 'noindex' });
  }
}
