import type { InputSignal, OutputEmitterRef, Type } from '@angular/core';
import type { BadgeVm, GameCardVm, GmSignatureVm } from '../core/games/game-card.vm';
import type { MyGameActionEvent, MyGameItemVm } from '../core/games/my-game-item.vm';

/**
 * Слоти дизайну — частини інтерфейсу, які кожен дизайн малює власним компонентом. Контракт
 * (inputs/outputs) однаковий для всіх дизайнів і для резервних компонентів `fallback/`:
 * слот лише показує дані й віддає події, логіка — у спільних view-model функціях.
 */
export type SlotName =
  'shell' | 'game-card' | 'my-game-item' | 'page-header' | 'empty-state' | 'badge' | 'gm-signature';

/** Компоненти дизайну для кожного слоту. */
export type ThemeSlots = Record<SlotName, Type<unknown>>;

/** Посилання-дія в заголовку сторінки чи порожньому стані. */
export interface SlotLinkAction {
  /** Стабільний ідентифікатор (атрибут `data-action`). */
  id: string;
  labelKey: string;
  /** Ім'я Material Symbols або `null`. */
  icon: string | null;
  link: string;
  /** Основна дія (заливка) чи другорядна (обведена). */
  primary: boolean;
}

/** Каркас сторінки: шапка, навігація, `<router-outlet>`, підвал. Без inputs/outputs. */
export type ShellSlot = object;

/** Картка гри в пошуку й профілі. */
export interface GameCardSlot {
  game: InputSignal<GameCardVm>;
}

/** Рядок «Моїх ігор» з діями майстра. */
export interface MyGameItemSlot {
  item: InputSignal<MyGameItemVm>;
  /** Поки триває дія з будь-якою грою — кнопки неактивні. */
  busy: InputSignal<boolean>;
  action: OutputEmitterRef<MyGameActionEvent>;
}

/** Заголовок сторінки (h1) з необов'язковим підзаголовком і діями. */
export interface PageHeaderSlot {
  titleKey: InputSignal<string>;
  leadKey: InputSignal<string | null>;
  actions: InputSignal<readonly SlotLinkAction[]>;
}

/** Порожній стан списку. */
export interface EmptyStateSlot {
  messageKey: InputSignal<string>;
  hintKey: InputSignal<string | null>;
  action: InputSignal<SlotLinkAction | null>;
}

/** Бейдж (вік, статус, збіг з розкладом). */
export interface BadgeSlot {
  badge: InputSignal<BadgeVm>;
}

/** Підпис майстра: нік-посилання, «заблоковано», рейтинг. */
export interface GmSignatureSlot {
  gm: InputSignal<GmSignatureVm>;
}

/** Outputs кожного слоту: `<nri-slot>` підписується на них і пересилає як `(output)`. */
export const SLOT_OUTPUTS: Record<SlotName, readonly string[]> = {
  shell: [],
  'game-card': [],
  'my-game-item': ['action'],
  'page-header': [],
  'empty-state': [],
  badge: [],
  'gm-signature': [],
};

/** Подія з компонента слоту: ім'я output і значення. */
export interface SlotOutputEvent<T = unknown> {
  name: string;
  value: T;
}
