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

/** Відповідь `GET /api/me`. */
export interface MeDto {
  id: number;
  /** Незмінний публічний ідентифікатор (`/users/<publicId>`). */
  publicId: string;
  nickname: string | null;
  avatarUrl: string | null;
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
