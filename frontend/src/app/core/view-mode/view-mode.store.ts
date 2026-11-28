import { Injectable, computed, effect, inject, linkedSignal, untracked } from '@angular/core';
import { DEFAULT_VIEW_MODE, type MeDto, type ViewMode, isViewMode } from '@nri/shared';
import { AuthStore } from '../auth/auth.store';

export type { ViewMode } from '@nri/shared';

const STORAGE_KEY = 'nri.viewMode';

/** Збережений у вкладці вид — разом з користувачем, для якого його обрано. */
interface StoredView {
  u: number;
  m: ViewMode;
}

/**
 * «Вид гравця / Вид майстра» — свій у кожній вкладці: обраний вид живе в `sessionStorage`
 * (переживає перезавантаження, не синхронізується між вкладками). Нова вкладка відкривається
 * у «Виді за замовчуванням» з профілю (`MeDto.defaultView`); гість — завжди «Вид гравця».
 */
@Injectable({ providedIn: 'root' })
export class ViewModeStore {
  private readonly auth = inject(AuthStore);
  private readonly activeUser = computed(() => {
    const me = this.auth.me();
    return this.auth.isActive() && me ? me : null;
  });

  private readonly activeUserId = computed(() => this.activeUser()?.id ?? null);

  /**
   * Перераховується лише при зміні користувача (вхід / вихід), а не при зміні налаштування
   * «Вид за замовчуванням» — відкрита вкладка свій вид не міняє.
   */
  private readonly state = linkedSignal<number | null, ViewMode>({
    source: this.activeUserId,
    computation: () => untracked(() => initialMode(this.activeUser())),
  });

  readonly mode = computed<ViewMode>(() => (this.activeUser() ? this.state() : DEFAULT_VIEW_MODE));

  constructor() {
    // Старий спільний для вкладок вид (до «свого виду у кожній вкладці») — більше не діє.
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Сховище недоступне — нічого прибирати.
    }
    // Вид, з яким вкладка відкрилась, запам'ятовуємо одразу (поза обчисленням стану):
    // перезавантаження не підхопить пізнішої зміни «Виду за замовчуванням».
    effect(() => {
      const user = this.activeUser();
      const mode = this.mode();
      if (user) writeStored({ u: user.id, m: mode });
    });
  }

  setMode(mode: ViewMode): void {
    const user = this.activeUser();
    if (!user) return;
    this.state.set(mode);
    writeStored({ u: user.id, m: mode });
  }
}

/**
 * Вид вкладки для користувача: обраний у ній раніше або «Вид за замовчуванням». Обчислення
 * чисте — запис у сховище робить ефект у конструкторі.
 */
function initialMode(user: MeDto | null): ViewMode {
  if (!user) return DEFAULT_VIEW_MODE;
  const stored = readStored();
  if (stored?.u === user.id) return stored.m;
  return isViewMode(user.defaultView) ? user.defaultView : DEFAULT_VIEW_MODE;
}

function writeStored(view: StoredView): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Приватний режим / заборонене сховище — працюємо лише в пам'яті.
  }
}

function readStored(): StoredView | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { u, m } = parsed as Partial<StoredView>;
    return typeof u === 'number' && isViewMode(m) ? { u, m } : null;
  } catch {
    return null;
  }
}
