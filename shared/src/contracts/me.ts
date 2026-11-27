import { z } from 'zod';
import { ianaTimezone } from '../schemas/common.js';
import type { ThemeId, UiPrefsDto } from './theme.js';

export type UserStatus = 'pending' | 'active' | 'deleted';
export type UserRole = 'owner' | 'admin' | 'moderator' | 'user';
export type IdentityProvider = 'telegram' | 'google' | 'discord' | 'dev';

export interface IdentityDto {
  provider: IdentityProvider;
  displayName: string | null;
}

/** Обране джерело аватара. `auto` — аватар провайдера, з яким створено акаунт (інакше будь-якого прив'язаного). */
export const AVATAR_SOURCES = ['auto', 'google', 'discord', 'telegram', 'custom', 'none'] as const;
export type AvatarSource = (typeof AVATAR_SOURCES)[number];
/** Провайдери, що дають аватар. */
export type AvatarProvider = 'google' | 'discord' | 'telegram';

/** Доступне джерело аватара (прив'язаний провайдер з аватаром) з URL для прев'ю. */
export interface AvatarOptionDto {
  source: AvatarProvider;
  previewUrl: string;
}

/** Відповідь `GET /api/me`. */
export interface MeDto {
  id: number;
  /** Незмінний публічний ідентифікатор (`/users/<publicId>`). */
  publicId: string;
  nickname: string | null;
  /** Ефективний аватар (за `avatarSource`). */
  avatarUrl: string | null;
  avatarSource: AvatarSource;
  customAvatarUrl: string | null;
  /** Прив'язані провайдери з аватаром — що можна обрати. */
  avatarOptions: AvatarOptionDto[];
  birthDate: string | null;
  role: UserRole;
  status: UserStatus;
  timezone: string;
  locale: string;
  identities: IdentityDto[];
  /** Ефективний дизайн сайту (збережений, якщо доступний ролі; інакше дефолтний). */
  uiTheme: ThemeId;
  /** Дизайни, доступні ролі користувача. */
  availableThemes: ThemeId[];
  /** Налаштування вигляду, що зберігаються в профілі (для всіх пристроїв). */
  uiPrefs: UiPrefsDto;
}

/**
 * `PATCH /api/me/timezone` → `MeDto`. Пояс акаунта визначає календар доступності (R5);
 * слоти календаря при зміні поясу не перераховуються — лишаються тим самим «настінним» часом.
 */
export const changeTimezoneSchema = z.object({ timezone: ianaTimezone }).strict();
export type ChangeTimezoneInput = z.infer<typeof changeTimezoneSchema>;

/** `PUT /api/me/avatar` → `MeDto`. `customUrl` обов'язковий (https) лише для `custom`. */
export const updateAvatarSchema = z
  .object({
    source: z.enum(AVATAR_SOURCES),
    customUrl: z
      .url({ protocol: /^https$/ })
      .max(512)
      .optional(),
  })
  .strict()
  .refine((v) => (v.source === 'custom') === (v.customUrl !== undefined), {
    message: 'customUrl is required for custom source only',
    path: ['customUrl'],
  });
export type UpdateAvatarInput = z.infer<typeof updateAvatarSchema>;
