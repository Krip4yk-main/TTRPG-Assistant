import {
  ageOn,
  GAME_PRIVATE_FIELDS,
  localDate,
  meetsAgeRating,
  type GameCardDto,
  type GameDto,
  type GameViewDto,
  type PublicGameDto,
  type RestrictedGameDto,
} from '@nri/shared';

/**
 * Хто дивиться: `null` — гість. Пояс потрібен, щоб вік рахувався за локальною датою глядача.
 */
export type Viewer = { userId: number; birthDate: string | null; timezone: string } | null;

/** Повних років глядача сьогодні; гість чи без дати народження — `null`. */
export function viewerAge(viewer: Viewer, now: Date = new Date()): number | null {
  if (!viewer?.birthDate) return null;
  return ageOn(viewer.birthDate, localDate(now, viewer.timezone));
}

/**
 * Гра прихована від усіх, крім майстра: чернетка або ніколи не опублікована (зокрема
 * скасована чернетка). Для таких ігор не-майстер отримує 404, а не 403.
 */
export function isHiddenFromNonGm(g: {
  status: GameDto['status'];
  publishedAt: Date | string | null;
}): boolean {
  return g.status === 'draft' || g.publishedAt === null;
}

function restrictedView(g: Pick<GameDto, 'id' | 'title' | 'gm' | 'ageRating'>): RestrictedGameDto {
  return {
    id: g.id,
    title: g.title,
    gm: {
      publicId: g.gm.publicId,
      nickname: g.gm.nickname,
      avatarUrl: g.gm.avatarUrl,
      ...(g.gm.blocked ? { blocked: true as const } : {}),
    },
    ageRating: g.ageRating,
    restricted: true,
  };
}

function isRestrictedFor(
  g: Pick<GameDto, 'ageRating'>,
  gmUserId: number,
  viewer: Viewer,
  now: Date,
): boolean {
  if (viewer?.userId === gmUserId) return false;
  return !meetsAgeRating(viewerAge(viewer, now), g.ageRating);
}

/**
 * Єдине місце правил видимості гри (`GET /api/games/:id`):
 * - неопублікована гра (чернетка або скасована чернетка, `publishedAt === null`) — лише
 *   майстру (іншим `null` → 404);
 * - майстер — повний вид;
 * - вікова позначка, якої глядач не проходить (гість — завжди для 18+/21+) — рівно
 *   `{ id, title, gm, ageRating, restricted: true }`;
 * - активний учасник (`game_members.left_at IS NULL`) — повний вид; колишній (вийшов,
 *   виключений, забанений) — як сторонній;
 * - інші — повний вид без `address` і `channelLinks`.
 */
export function toGameView(
  game: GameDto,
  gmUserId: number,
  viewer: Viewer,
  isMember: boolean,
  now: Date = new Date(),
): GameViewDto | null {
  const isGm = viewer?.userId === gmUserId;
  if (isHiddenFromNonGm(game) && !isGm) return null;
  if (isGm) return game;
  if (isRestrictedFor(game, gmUserId, viewer, now)) return restrictedView(game);
  if (isMember) return game;
  const pub: Partial<GameDto> = { ...game };
  for (const f of GAME_PRIVATE_FIELDS) delete pub[f];
  return pub as PublicGameDto;
}

/** Картка гри для списків: та сама вікова перевірка, що й у `toGameView`. */
export function toCardView(
  card: GameCardDto,
  gmUserId: number,
  viewer: Viewer,
  now: Date = new Date(),
): GameCardDto | RestrictedGameDto {
  return isRestrictedFor(card, gmUserId, viewer, now) ? restrictedView(card) : card;
}
