import { Injectable, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { type RouterStateSnapshot, TitleStrategy } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';

/** `title` маршруту — ключ i18n; заголовок вкладки: «<сторінка> — НРІ Асистент». */
@Injectable({ providedIn: 'root' })
export class TranslatedTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly translate = inject(TranslateService);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const key = this.buildTitle(snapshot);
    const keys = key ? [key, 'app.title'] : ['app.title'];
    this.translate.get(keys).subscribe((t: Record<string, string>) => {
      const app = t['app.title'] ?? '';
      const page = key ? t[key] : undefined;
      this.title.setTitle(page && page !== app ? `${page} — ${app}` : app);
    });
  }
}
