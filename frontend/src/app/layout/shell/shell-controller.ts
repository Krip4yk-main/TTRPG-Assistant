import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthStore } from '../../core/auth/auth.store';
import { isStaff } from '../../core/auth/roles';
import { ViewModeRouting } from '../../core/view-mode/view-mode-routing';
import { type ViewMode, ViewModeStore } from '../../core/view-mode/view-mode.store';

/**
 * Логіка каркаса сторінки, спільна для слоту `shell` усіх дизайнів (і резервного): хто що
 * бачить у навігації, вихід, повторна перевірка сесії. Компоненти каркаса лише показують.
 */
@Injectable({ providedIn: 'root' })
export class ShellController {
  readonly auth = inject(AuthStore);
  readonly viewMode = inject(ViewModeStore);
  private readonly router = inject(Router);
  private readonly viewRouting = inject(ViewModeRouting);

  /** Персонал (модератор і вище) бачить у меню «Адмінку». */
  readonly isStaff = computed(() => this.auth.isActive() && isStaff(this.auth.me()?.role));

  private readonly retryingState = signal(false);
  readonly retrying = this.retryingState.asReadonly();

  /**
   * Перемикач виду: на сторінці іншого виду — перехід на відповідник або головну. Якщо перехід
   * скасовано (незбережені зміни), `toggle` повертаємо до справжнього виду — інакше перемикач
   * показував би вид, якого немає.
   */
  async setMode(mode: ViewMode, toggle?: { value: unknown }): Promise<void> {
    const switched = await this.viewRouting.switchTo(mode);
    if (!switched && toggle) toggle.value = this.viewMode.mode();
  }

  async logout(): Promise<void> {
    try {
      await this.auth.logout();
    } catch {
      // Локальний стан уже очищено; сесію на сервері можна завершити пізніше.
    } finally {
      await this.router.navigateByUrl('/login');
    }
  }

  /** Повторна перевірка сесії після збою сервера/мережі. */
  async retry(): Promise<void> {
    if (this.retryingState()) return;
    this.retryingState.set(true);
    try {
      await this.auth.load();
      if (!this.auth.loadFailed()) {
        const blocked = this.auth.takeBlockedUrl();
        if (blocked) await this.router.navigateByUrl(blocked);
      }
    } finally {
      this.retryingState.set(false);
    }
  }
}
