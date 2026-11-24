import { Injectable, signal } from '@angular/core';

export type ViewMode = 'player' | 'gm';

const STORAGE_KEY = 'nri.viewMode';
const DEFAULT_MODE: ViewMode = 'player';

function isViewMode(value: unknown): value is ViewMode {
  return value === 'player' || value === 'gm';
}

/** «Вид гравця / Вид майстра». Зберігається в localStorage, якщо він доступний. */
@Injectable({ providedIn: 'root' })
export class ViewModeStore {
  private readonly state = signal<ViewMode>(readStored());
  readonly mode = this.state.asReadonly();

  setMode(mode: ViewMode): void {
    this.state.set(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Приватний режим / заборонене сховище — працюємо лише в пам'яті.
    }
  }
}

function readStored(): ViewMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isViewMode(stored) ? stored : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}
