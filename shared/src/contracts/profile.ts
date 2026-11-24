import { z } from 'zod';
import type { GameCardDto, RestrictedGameDto } from './games.js';
import type { UserStatus } from './me.js';

export const EXPERIENCE_LEVELS = ['none', 'beginner', 'intermediate', 'veteran'] as const;
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

export const PREFERRED_FORMATS = ['online', 'offline'] as const;
export type PreferredFormat = (typeof PREFERRED_FORMATS)[number];

/** Поля профілю, які можна приховати. Відсутній ключ = видимо. */
export const PROFILE_PRIVACY_KEYS = [
  'bio',
  'city',
  'favoriteSystems',
  'preferredFormats',
  'experience',
] as const;
export type ProfilePrivacyKey = (typeof PROFILE_PRIVACY_KEYS)[number];
export type ProfilePrivacy = Record<ProfilePrivacyKey, boolean>;

/** Власний повний профіль (`GET/PATCH /api/me/profile`). `privacy` — з розкритими значеннями. */
export interface ProfileDto {
  bio: string | null;
  city: string | null;
  favoriteSystemIds: number[];
  preferredFormats: PreferredFormat[];
  experience: ExperienceLevel | null;
  /** `true` = поле видиме іншим. */
  privacy: ProfilePrivacy;
}

/** Часткове оновлення: передані поля змінюються, privacy зливається по ключах. */
export const profileInputSchema = z
  .object({
    bio: z.string().trim().max(1000).nullable(),
    city: z.string().trim().max(80).nullable(),
    favoriteSystemIds: z
      .array(z.number().int().positive())
      .max(10)
      .transform((ids) => [...new Set(ids)]),
    preferredFormats: z
      .array(z.enum(PREFERRED_FORMATS))
      .max(2)
      .transform((f) => [...new Set(f)]),
    experience: z.enum(EXPERIENCE_LEVELS).nullable(),
    privacy: z
      .object(
        Object.fromEntries(PROFILE_PRIVACY_KEYS.map((k) => [k, z.boolean().optional()])) as Record<
          ProfilePrivacyKey,
          z.ZodOptional<z.ZodBoolean>
        >,
      )
      .strict(),
  })
  .partial()
  .strict()
  .transform((v) => ({
    ...v,
    bio: v.bio === '' ? null : v.bio,
    city: v.city === '' ? null : v.city,
  }));

export type ProfileInput = z.input<typeof profileInputSchema>;

/**
 * Публічний профіль (`GET /api/users/:publicId`). Приховані поля відсутні в JSON.
 * Видалений користувач — лише `{ publicId, status: 'deleted' }`.
 */
export interface PublicProfileDto {
  publicId: string;
  status: UserStatus;
  nickname?: string | null;
  avatarUrl?: string | null;
  bio?: string;
  city?: string;
  favoriteSystemIds?: number[];
  preferredFormats?: PreferredFormat[];
  experience?: ExperienceLevel;
  /**
   * Опубліковані ігри у статусах recruiting|started|finished|cancelled (без чернеток;
   * скасована неопублікована гра не показується). Гра 18+/21+,
   * якої глядач не проходить за віком, — у вигляді `RestrictedGameDto`.
   */
  gamesAsGm?: (GameCardDto | RestrictedGameDto)[];
  /** Ігри, де користувач — учасник (`game_members`); ті самі правила. */
  gamesAsPlayer?: (GameCardDto | RestrictedGameDto)[];
}
