import { DOCUMENT } from '@angular/common';
import {
  type AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injectable,
  inject,
  signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { GUEST_THEMES, type ThemeId } from '@nri/shared';
import { STYLE_WAIT_MS, FONT_WAIT_MS, ThemeService } from '../theme.service';

/** Значок дизайну в перемикачі (на вузькому екрані — лише він); невідомий — загальний. */
const ICONS: Partial<Record<ThemeId, string>> = {
  'quest-board': 'push_pin',
  'night-city': 'location_city',
};

/** Ширина, з якої поруч зі значком видно назву дизайну (як медіа-запит у стилях). */
const WIDE_QUERY = '(min-width: 768px)';

/**
 * Скільки чекати нову шапку з перемикачем, щоб повернути в неї фокус: найдовше перемикання
 * дизайну (бандл + шрифт) із запасом. Пізніше — фокус не чіпаємо (користувач уже деінде).
 */
export const FOCUS_HANDOFF_MS = STYLE_WAIT_MS + FONT_WAIT_MS + 1000;

/**
 * Передача фокуса між перемикачами: при зміні дизайну стара шапка (з кнопкою у фокусі)
 * знищується, а новий перемикач, з'явившись, забирає фокус собі.
 */
@Injectable({ providedIn: 'root' })
export class GuestToggleFocus {
  private pendingUntil = 0;

  /** Кнопка у фокусі обрала дизайн — новий перемикач має взяти фокус. */
  request(): void {
    this.pendingUntil = Date.now() + FOCUS_HANDOFF_MS;
  }

  /** Чи є непрострочений запит (і скинути його). */
  take(): boolean {
    const pending = Date.now() <= this.pendingUntil;
    this.pendingUntil = 0;
    return pending;
  }
}

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
export class GuestThemeToggle implements AfterViewInit {
  protected readonly themes = inject(ThemeService);
  protected readonly options = GUEST_THEMES.map((id) => ({
    id,
    icon: ICONS[id] ?? 'palette',
  }));

  private readonly doc = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly focus = inject(GuestToggleFocus);

  /** Назву видно (широкий екран) — підказка `title` зайва; вузький — лише значок і підказка. */
  protected readonly wide = signal(true);

  constructor() {
    const media = this.doc.defaultView?.matchMedia?.(WIDE_QUERY);
    if (media) {
      this.wide.set(media.matches);
      const onChange = (e: MediaQueryListEvent) => this.wide.set(e.matches);
      media.addEventListener('change', onChange);
      inject(DestroyRef).onDestroy(() => media.removeEventListener('change', onChange));
    }
  }

  /**
   * Новий перемикач (у шапці щойно показаного дизайну): якщо попередній перемикач віддав фокус,
   * а він ніде не тримається (стару кнопку знищено) — фокус на обрану кнопку.
   */
  ngAfterViewInit(): void {
    if (!this.focus.take()) return;
    const active = this.doc.activeElement;
    if (active && active !== this.doc.body && active.isConnected) return;
    this.host.nativeElement.querySelector<HTMLElement>('button[aria-pressed="true"]')?.focus();
  }

  protected pick(id: ThemeId, button: HTMLElement): void {
    if (id === this.themes.guestTheme()) return;
    // Інший дизайн — інший каркас: цей перемикач знищиться разом зі старою шапкою.
    if (this.doc.activeElement === button) this.focus.request();
    void this.themes.select(id);
  }
}
