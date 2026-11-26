import type { ThemeSlots } from '../../slots';
import { CyberBadge } from './badge/cyber-badge';
import { CyberEmptyState } from './empty-state/cyber-empty-state';
import { CyberGameCard } from './game-card/cyber-game-card';
import { CyberGmSignature } from './gm-signature/cyber-gm-signature';
import { CyberMyGameItem } from './my-game-item/cyber-my-game-item';
import { CyberPageHeader } from './page-header/cyber-page-header';
import { CyberShell } from './shell/cyber-shell';

/**
 * Слоти кібер-родини — один лінивий чанк для трьох дизайнів («Неонові вивіски», «Голо-ринок»,
 * «Нічне місто», див. `THEMES`). Розмітка спільна (з декоративними елементами для кожного
 * варіанта), а вигляд задає бандл стилів конкретного дизайну через `:root[data-theme]`.
 */
export const CYBER_SLOTS: ThemeSlots = {
  shell: CyberShell,
  'game-card': CyberGameCard,
  'my-game-item': CyberMyGameItem,
  'page-header': CyberPageHeader,
  'empty-state': CyberEmptyState,
  badge: CyberBadge,
  'gm-signature': CyberGmSignature,
};
