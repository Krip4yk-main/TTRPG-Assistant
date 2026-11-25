import { signal, type Provider } from '@angular/core';
import type { ThemeSlots } from './slots';
import { ThemeService } from './theme.service';

/**
 * Для spec-ів сторінок: `<nri-slot>` одразу малює компоненти заданого дизайну (без
 * ініціалізатора застосунку й лінивого чанку).
 */
export function provideThemeSlots(slots: ThemeSlots): Provider {
  return { provide: ThemeService, useValue: { slots: signal(slots).asReadonly() } };
}
