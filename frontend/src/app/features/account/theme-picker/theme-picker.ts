import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import type { ThemeId } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { toApiError } from '../../../core/api/api-error';
import { THEME_REGISTRY } from '../../../theming/theme.registry';
import { ThemeService } from '../../../theming/theme.service';

/**
 * Розділ «Вигляд» налаштувань акаунта: картки доступних дизайнів (мініатюра й назва).
 * Показується лише коли є з чого вибирати. Вибір позначається одразу (оптимістично) і
 * застосовується без перезавантаження; помилка збереження — повідомлення й попередній вибір.
 */
@Component({
  selector: 'nri-theme-picker',
  imports: [TranslatePipe],
  templateUrl: './theme-picker.html',
  styleUrl: './theme-picker.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThemePicker {
  private readonly themes = inject(ThemeService);
  private readonly auth = inject(AuthStore);
  private readonly registry = inject(THEME_REGISTRY);

  /** Дизайн, який зараз зберігається (позначений одразу, до відповіді сервера). */
  private readonly pending = signal<ThemeId | null>(null);

  protected readonly options = computed(() =>
    this.themes.available().map((id) => this.registry[id]),
  );
  protected readonly visible = computed(() => this.options().length > 1);
  protected readonly selected = computed(() => this.pending() ?? this.themes.theme());
  protected readonly busy = computed(() => this.pending() !== null);
  protected readonly errorKey = signal<string | null>(null);

  protected async choose(id: ThemeId): Promise<void> {
    if (this.busy() || id === this.selected()) return;
    this.errorKey.set(null);
    this.pending.set(id);
    try {
      await this.themes.select(id);
    } catch (err) {
      const { code } = toApiError(err);
      // 401 уже обробив authInterceptor.
      if (code !== 'UNAUTHENTICATED') this.errorKey.set(`errors.${code}`);
      // Права на дизайн змінилися — оновлюємо користувача, щоб зник недоступний варіант.
      if (code === 'THEME_NOT_AVAILABLE') await this.auth.load();
    } finally {
      // Успіх — чинний дизайн уже новий; помилка — повертається попередній.
      this.pending.set(null);
    }
  }
}
