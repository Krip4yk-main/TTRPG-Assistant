import type { ThemeSlots } from '../slots';
import { FallbackBadge } from './badge/fallback-badge';
import { FallbackEmptyState } from './empty-state/fallback-empty-state';
import { FallbackGameCard } from './game-card/fallback-game-card';
import { FallbackGmSignature } from './gm-signature/fallback-gm-signature';
import { FallbackMyGameItem } from './my-game-item/fallback-my-game-item';
import { FallbackPageHeader } from './page-header/fallback-page-header';
import { FallbackShell } from './shell/fallback-shell';

/**
 * Резервні компоненти слотів (у початковому бандлі): поки чанк дизайну вантажиться або якщо
 * він не завантажився. Той самий контракт, що в дизайнах, проста розмітка без декору.
 */
export const FALLBACK_SLOTS: ThemeSlots = {
  shell: FallbackShell,
  'game-card': FallbackGameCard,
  'my-game-item': FallbackMyGameItem,
  'page-header': FallbackPageHeader,
  'empty-state': FallbackEmptyState,
  badge: FallbackBadge,
  'gm-signature': FallbackGmSignature,
};
