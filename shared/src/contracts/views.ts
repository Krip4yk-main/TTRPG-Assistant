import { z } from 'zod';

/** Сутності, для яких зберігається «переглянуто» (`entity_views`). */
export const ENTITY_VIEW_TYPES = ['game', 'application', 'session'] as const;
export type EntityViewType = (typeof ENTITY_VIEW_TYPES)[number];

/**
 * Стан перегляду в DTO: `new` — користувач ще не відкривав сутність; `updated` — її змінив
 * хтось інший після останнього перегляду; `seen` — переглянуто, змін немає. Власні зміни
 * користувача стан на `updated` не перемикають.
 */
export const SEEN_STATES = ['new', 'updated', 'seen'] as const;
export type SeenState = (typeof SEEN_STATES)[number];

export const ENTITY_VIEWS_MAX_IDS = 100;

/**
 * Тіло `POST /api/me/views`: фронтенд позначає переглянутими показані сутності. Невидимі
 * користувачеві й неіснуючі id мовчки ігноруються (відповідь завжди 204).
 */
export const entityViewsInputSchema = z
  .object({
    entityType: z.enum(ENTITY_VIEW_TYPES),
    ids: z
      .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
      .min(1)
      .max(ENTITY_VIEWS_MAX_IDS),
  })
  .strict();
export type EntityViewsInput = z.input<typeof entityViewsInputSchema>;
