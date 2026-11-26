import type { ThemeSlots } from '../../slots';
import { SceneBadge } from './badge/scene-badge';
import { SceneEmptyState } from './empty-state/scene-empty-state';
import { SceneGameCard } from './game-card/scene-game-card';
import { SceneGmSignature } from './gm-signature/scene-gm-signature';
import { SceneMyGameItem } from './my-game-item/scene-my-game-item';
import { ScenePageHeader } from './page-header/scene-page-header';
import { SceneShell } from './shell/scene-shell';

/**
 * Слоти родини сцени — один лінивий чанк для всіх дизайнів сцени (кібер-дизайни «Неонові
 * вивіски», «Голо-ринок», «Нічне місто» й наступні, див. `THEMES`). Розмітка спільна (з
 * загальними гачками декору — карта в scene-base.less), а вигляд задає бандл стилів
 * конкретного дизайну через `:root[data-theme]`.
 */
export const SCENE_SLOTS: ThemeSlots = {
  shell: SceneShell,
  'game-card': SceneGameCard,
  'my-game-item': SceneMyGameItem,
  'page-header': ScenePageHeader,
  'empty-state': SceneEmptyState,
  badge: SceneBadge,
  'gm-signature': SceneGmSignature,
};
