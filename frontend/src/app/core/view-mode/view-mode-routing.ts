import { Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  type ActivatedRouteSnapshot,
  GuardsCheckEnd,
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  Router,
} from '@angular/router';
import { type ViewMode, isViewMode } from '@nri/shared';
import { ViewModeStore } from './view-mode.store';

/** `data` маршруту, що належить одному виду. Решта сторінок — спільні (без `view`). */
export interface ViewRouteData {
  view: ViewMode;
  /** Сторінка іншого виду, на яку ведемо при перемиканні виду (інакше — головна). */
  viewCounterpart?: string;
}

/** Сторінка «Виду майстра». */
export function gmPage(counterpart?: string): ViewRouteData {
  return counterpart ? { view: 'gm', viewCounterpart: counterpart } : { view: 'gm' };
}

/** Сторінка «Виду гравця». */
export function playerPage(counterpart?: string): ViewRouteData {
  return counterpart ? { view: 'player', viewCounterpart: counterpart } : { view: 'player' };
}

/** Вид сторінки за найглибшим маршрутом, що його задає; `null` — спільна сторінка. */
function pageView(root: ActivatedRouteSnapshot): ViewRouteData | null {
  let found: ViewRouteData | null = null;
  for (let route: ActivatedRouteSnapshot | null = root; route; route = route.firstChild) {
    const view: unknown = route.data['view'];
    if (isViewMode(view)) {
      const counterpart: unknown = route.data['viewCounterpart'];
      found = typeof counterpart === 'string' ? { view, viewCounterpart: counterpart } : { view };
    }
  }
  return found;
}

/** Перехід, яким перемикаємо вид (`NavigationBehaviorOptions.info`, не потрапляє в історію). */
interface SwitchInfo {
  viewSwitch: ViewMode;
}

function switchOf(info: unknown): ViewMode | null {
  const view = (info as Partial<SwitchInfo> | null | undefined)?.viewSwitch;
  return isViewMode(view) ? view : null;
}

/**
 * Вид і сторінки: у «Виді гравця» не видно сторінок майстра, і навпаки.
 * - Перехід на сторінку іншого виду (посилання, сповіщення, закладка, перезавантаження) одразу
 *   перемикає вид на вид сторінки — сторінка відкривається, а не блокується.
 * - Перемикання виду на сторінці іншого виду веде на відповідник або головну; вид змінюється
 *   лише якщо перехід відбувся (guard-и незбережених змін можуть його скасувати).
 * Вид визначається на `GuardsCheckEnd` (після всіх guard-ів), а застосовується на `NavigationEnd`:
 * збій (чанк, що не завантажився) або перехід, який витіснила інша навігація, вид не змінює.
 */
@Injectable({ providedIn: 'root' })
export class ViewModeRouting {
  private readonly router = inject(Router);
  private readonly store = inject(ViewModeStore);

  /** Вид, який навігація `id` застосує, коли завершиться успішно. */
  private pending: { id: number; view: ViewMode } | null = null;

  constructor() {
    this.router.events.pipe(takeUntilDestroyed()).subscribe((e) => {
      if (e instanceof GuardsCheckEnd) {
        if (!e.shouldActivate) return;
        const requested = switchOf(this.router.currentNavigation()?.extras.info);
        const view = requested ?? pageView(e.state.root)?.view;
        this.pending = view ? { id: e.id, view } : null;
      } else if (e instanceof NavigationEnd) {
        const pending = this.pending;
        this.pending = null;
        if (pending?.id === e.id && pending.view !== this.store.mode()) {
          this.store.setMode(pending.view);
        }
      } else if (
        e instanceof NavigationCancel ||
        e instanceof NavigationError ||
        e instanceof NavigationSkipped
      ) {
        if (this.pending?.id === e.id) this.pending = null;
      }
    });
  }

  /** Перемикач виду в каркасі. `false` — перехід скасовано, вид не змінився. */
  async switchTo(mode: ViewMode): Promise<boolean> {
    if (mode === this.store.mode()) return true;
    const page = pageView(this.router.routerState.snapshot.root);
    if (!page || page.view === mode) {
      this.store.setMode(mode);
      return true;
    }
    const info: SwitchInfo = { viewSwitch: mode };
    const navigated = await this.router.navigateByUrl(page.viewCounterpart ?? '/', { info });
    return navigated === true;
  }
}
