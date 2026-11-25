import { Injectable, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { type RouterStateSnapshot, TitleStrategy } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { SeoService } from '../seo/seo.service';

/**
 * `title` маршруту — ключ i18n; заголовок вкладки: «<сторінка> — НРІ Асистент».
 * Кожна навігація скидає метадані попередньої сторінки (опис, og:*, `noindex`); `noindex`
 * лишається, якщо його вимагає `data.noindex` маршруту.
 */
@Injectable({ providedIn: 'root' })
export class TranslatedTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly translate = inject(TranslateService);
  private readonly seo = inject(SeoService);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    this.seo.reset();
    // `data: { noindex: true }` маршруту (напр. 404) — після скидання, на кожній навігації:
    // компонент між двома такими адресами перевикористовується й сам би його не повторив.
    let route = snapshot.root;
    while (route.firstChild) route = route.firstChild;
    if (route.data['noindex'] === true) this.seo.noindex();
    const key = this.buildTitle(snapshot);
    const keys = key ? [key, 'app.title'] : ['app.title'];
    this.translate.get(keys).subscribe((t: Record<string, string>) => {
      const app = t['app.title'] ?? '';
      const page = key ? t[key] : undefined;
      this.title.setTitle(page && page !== app ? `${page} — ${app}` : app);
    });
  }
}
