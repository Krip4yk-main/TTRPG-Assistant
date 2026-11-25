import { and, eq, inArray } from 'drizzle-orm';
import {
  PROFILE_PRIVACY_KEYS,
  type ProfileDto,
  type ProfilePrivacy,
  type PublicProfileDto,
  type profileInputSchema,
} from '@nri/shared';
import type { z } from 'zod';
import type { AppDeps } from '../app.js';
import { gameSystems, userProfiles, users } from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import { AppError } from '../http/errors.js';
import { listProfileGames } from '../games/games.service.js';
import type { Viewer } from '../games/games.visibility.js';
import { NO_RATINGS } from '../ratings/ratings.aggregate.js';
import { userRatings } from '../ratings/ratings.service.js';

type ProfileRow = Omit<typeof userProfiles.$inferSelect, 'userId'>;
export type ProfilePatch = z.output<typeof profileInputSchema>;

const EMPTY: ProfileRow = {
  bio: null,
  city: null,
  favoriteSystemIds: [],
  preferredFormats: [],
  experience: null,
  privacy: {},
};

async function loadRow(deps: AppDeps, userId: number): Promise<ProfileRow> {
  const [row] = await deps.db.select().from(userProfiles).where(eq(userProfiles.userId, userId));
  return row ?? EMPTY;
}

function resolvePrivacy(p: ProfileRow['privacy']): ProfilePrivacy {
  return Object.fromEntries(PROFILE_PRIVACY_KEYS.map((k) => [k, p[k] !== false])) as ProfilePrivacy;
}

function toDto(row: ProfileRow): ProfileDto {
  return {
    bio: row.bio,
    city: row.city,
    favoriteSystemIds: row.favoriteSystemIds,
    preferredFormats: row.preferredFormats,
    experience: row.experience,
    privacy: resolvePrivacy(row.privacy),
  };
}

export async function getOwnProfile(deps: AppDeps, userId: number): Promise<ProfileDto> {
  return toDto(await loadRow(deps, userId));
}

export async function updateProfile(
  deps: AppDeps,
  userId: number,
  patch: ProfilePatch,
): Promise<ProfileDto> {
  const { db } = deps;
  if (patch.favoriteSystemIds?.length) {
    const found = await db
      .select({ id: gameSystems.id })
      .from(gameSystems)
      .where(and(inArray(gameSystems.id, patch.favoriteSystemIds), eq(gameSystems.isActive, true)));
    if (found.length !== patch.favoriteSystemIds.length) {
      throw new AppError(400, 'VALIDATION', { reason: 'UNKNOWN_SYSTEM' });
    }
  }
  const current = await loadRow(deps, userId);
  const privacy: ProfileRow['privacy'] = { ...current.privacy };
  for (const k of PROFILE_PRIVACY_KEYS) {
    const v = patch.privacy?.[k];
    if (v !== undefined) privacy[k] = v;
  }
  const next: ProfileRow = {
    bio: patch.bio !== undefined ? patch.bio : current.bio,
    city: patch.city !== undefined ? patch.city : current.city,
    favoriteSystemIds: patch.favoriteSystemIds ?? current.favoriteSystemIds,
    preferredFormats: patch.preferredFormats ?? current.preferredFormats,
    experience: patch.experience !== undefined ? patch.experience : current.experience,
    privacy,
  };
  await db
    .insert(userProfiles)
    .values({ userId, ...next })
    .onDuplicateKeyUpdate({ set: next });
  await logEvent(db, {
    type: 'profile.updated',
    userId,
    entityType: 'user',
    entityId: userId,
    payload: {
      fields: Object.keys(patch).filter((k) => patch[k as keyof ProfilePatch] !== undefined),
    },
  });
  return toDto(next);
}

export async function getPublicProfile(
  deps: AppDeps,
  publicId: string,
  viewer: Viewer,
): Promise<PublicProfileDto> {
  const [u] = await deps.db.select().from(users).where(eq(users.publicId, publicId));
  if (!u || u.status === 'pending') throw new AppError(404, 'NOT_FOUND');
  if (u.status === 'deleted') {
    return { publicId: u.publicId, status: 'deleted', ratings: { ...NO_RATINGS } };
  }
  const row = await loadRow(deps, u.id);
  const visible = resolvePrivacy(row.privacy);
  const dto: PublicProfileDto = {
    publicId: u.publicId,
    nickname: u.nickname,
    avatarUrl: u.avatarUrl,
    status: u.status,
    ratings: await userRatings(deps, u.id),
  };
  if (visible.bio && row.bio !== null) dto.bio = row.bio;
  if (visible.city && row.city !== null) dto.city = row.city;
  if (visible.favoriteSystems) dto.favoriteSystemIds = row.favoriteSystemIds;
  if (visible.preferredFormats) dto.preferredFormats = row.preferredFormats;
  if (visible.experience && row.experience !== null) dto.experience = row.experience;
  const { asGm, asPlayer } = await listProfileGames(deps, u.id, viewer);
  dto.gamesAsGm = asGm;
  dto.gamesAsPlayer = asPlayer;
  return dto;
}

export type PublicProfileHead = {
  status: 'active' | 'deleted';
  isBanned: boolean;
  nickname: string | null;
  avatarUrl: string | null;
  bio: string | null;
};

/** Легка «голова» профілю для OG: без списків ігор; `null` — немає або ще pending. */
export async function getPublicProfileHead(
  deps: AppDeps,
  publicId: string,
): Promise<PublicProfileHead | null> {
  const [u] = await deps.db.select().from(users).where(eq(users.publicId, publicId));
  if (!u || u.status === 'pending') return null;
  if (u.status === 'deleted') {
    return { status: 'deleted', isBanned: false, nickname: null, avatarUrl: null, bio: null };
  }
  const row = await loadRow(deps, u.id);
  const visible = resolvePrivacy(row.privacy);
  return {
    status: 'active',
    isBanned: u.isBanned,
    nickname: u.nickname,
    avatarUrl: u.avatarUrl,
    bio: visible.bio ? row.bio : null,
  };
}
