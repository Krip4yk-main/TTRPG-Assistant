import { z } from 'zod';
import { THEME_IDS } from './theme.js';

/**
 * `PATCH /api/me/theme` → `MeDto`. Окремо від `theme.ts`: фронтенд бере звідти значення в
 * початковий бандл, і схема (а з нею zod) не має тягнутися туди разом з ними.
 */
export const updateThemeSchema = z.object({ theme: z.enum(THEME_IDS) }).strict();

/** `PATCH /api/me/ui-prefs` → `MeDto`: лише змінені налаштування, але хоч одне. */
export const updateUiPrefsSchema = z
  .object({ tearAnimation: z.boolean().optional(), sendAnimation: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one preference' });
export type UpdateUiPrefsInput = z.infer<typeof updateUiPrefsSchema>;
