import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { GUEST_THEMES, type ThemeId } from '@nri/shared';
import { ThemeService } from '../theme.service';

/** Значок дизайну в перемикачі (на вузькому екрані — лише він); невідомий — загальний. */
const ICONS: Partial<Record<ThemeId, string>> = {
  'quest-board': 'push_pin',
  'night-city': 'location_city',
};

/**
 * Перемикач дизайну для гостя в шапці (обидва каркаси): дві кнопки з `GUEST_THEMES`,
 * `aria-pressed` — обраний. Вибір — через `ThemeService.select` (лише `localStorage`; новий
 * дизайн показується, коли завантажились його стилі й шрифт). Користувач, що ввійшов, не бачить
 * перемикача — у нього «Вигляд» у налаштуваннях. Кольори задає каркас змінними `--gt-*`.
 */
@Component({
  selector: 'nri-guest-theme-toggle',
  imports: [MatIconModule, TranslatePipe],
  templateUrl: './guest-theme-toggle.html',
  styleUrl: './guest-theme-toggle.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GuestThemeToggle {
  protected readonly themes = inject(ThemeService);
  protected readonly options = GUEST_THEMES.map((id) => ({
    id,
    icon: ICONS[id] ?? 'palette',
  }));

  private readonly doc = inject(DOCUMENT);

  protected pick(id: ThemeId, button: HTMLElement): void {
    if (id === this.themes.guestTheme()) return;
    const hadFocus = this.doc.activeElement === button;
    void this.themes.select(id).then(() => {
      // Інший дизайн — інший каркас: цей перемикач знищено разом зі старою шапкою. Фокус
      // клавіатури не губиться — переходить на ту саму кнопку в новій шапці.
      if (!hadFocus) return;
      setTimeout(() => {
        const active = this.doc.activeElement;
        if (active && active !== this.doc.body && active.isConnected) return;
        this.doc
          .querySelector<HTMLElement>(`nri-guest-theme-toggle button[data-theme-id="${id}"]`)
          ?.focus();
      });
    });
  }
}
