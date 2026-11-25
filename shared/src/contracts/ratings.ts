import { z } from 'zod';

/**
 * Роль/джерело оцінки: оцінка майстра гри → `gm`; оцінка учасника від майстра гри →
 * `player_from_gm`; оцінка учасника від іншого учасника → `player_from_player`.
 */
export const RATING_ROLES = ['gm', 'player_from_gm', 'player_from_player'] as const;
export type RatingRole = (typeof RATING_ROLES)[number];

/** `session` — після сесії; `final` — підсумкова (кінець гри або вихід когось із пари). */
export const RATING_KINDS = ['session', 'final'] as const;
export type RatingKind = (typeof RATING_KINDS)[number];

export const GM_CRITERIA = [
  'preparation',
  'atmosphere',
  'fairness',
  'organization',
  'safety',
] as const;
export type GmCriterion = (typeof GM_CRITERIA)[number];

export const PLAYER_CRITERIA = ['punctuality', 'engagement', 'teamplay', 'respect'] as const;
export type PlayerCriterion = (typeof PLAYER_CRITERIA)[number];

/** Усі відомі критерії; належність критерію до ролі цілі перевіряє бекенд. */
export const RATING_CRITERIA = [...GM_CRITERIA, ...PLAYER_CRITERIA] as const;
export type RatingCriterion = GmCriterion | PlayerCriterion;

/** Набір критеріїв, дозволений для ролі цілі. */
export function criteriaForRole(role: RatingRole): readonly RatingCriterion[] {
  return role === 'gm' ? GM_CRITERIA : PLAYER_CRITERIA;
}

/** Перша публікація — від 5 одиниць; критерій показується від 5 одиниць. */
export const RATING_MIN_UNITS = 5;
/** Наступна публікація — коли з'явилось ще ≥ 5 нових одиниць. */
export const RATING_BATCH_UNITS = 5;
export const SESSION_RATING_WINDOW_DAYS = 14;
export const FINAL_RATING_WINDOW_DAYS = 30;
export const RATING_COMMENT_MAX = 2000;
export const RATING_SCORE_MIN = 1;
export const RATING_SCORE_MAX = 5;

const score = z.number().int().min(RATING_SCORE_MIN).max(RATING_SCORE_MAX);

const target = {
  /** `publicId` того, кого оцінюють. */
  rateeId: z.string().min(1).max(32),
  /** Сесійна оцінка; без нього — підсумкова. */
  sessionId: z.number().int().positive().optional(),
};

const declinedRatingSchema = z.object({ ...target, declined: z.literal(true) }).strict();

const scoredRatingSchema = z
  .object({
    ...target,
    overall: score,
    criteria: z.partialRecord(z.enum(RATING_CRITERIA), score).optional(),
    /** Бачить лише адміністрація. Порожній після trim → відсутній. */
    comment: z
      .string()
      .trim()
      .max(RATING_COMMENT_MAX)
      .optional()
      .transform((v) => (v ? v : undefined)),
  })
  .strict();

/** Тіло `POST /api/games/:id/ratings`: або відмова, або оцінка (загальна обов'язкова). */
export const ratingInputSchema = z.union([declinedRatingSchema, scoredRatingSchema]);
export type RatingInput = z.input<typeof ratingInputSchema>;
export type RatingInputParsed = z.output<typeof ratingInputSchema>;

export const RATING_TARGET_STATES = ['open', 'rated', 'declined'] as const;
export type RatingTargetState = (typeof RATING_TARGET_STATES)[number];

export interface RatingTargetDto {
  publicId: string;
  nickname: string;
  avatarUrl: string | null;
  /** Роль/джерело, під якою піде оцінка цієї цілі. */
  role: RatingRole;
  state: RatingTargetState;
  /** ISO; коли закривається вікно (для «вихідної» оцінки під час кампанії — орієнтир). */
  closesAt: string;
}

export interface RatingTargetsDto {
  gameId: number;
  /** `null` — підсумкові/«вихідні» цілі. */
  sessionId: number | null;
  kind: RatingKind;
  targets: RatingTargetDto[];
}

/** Опублікований зріз (1 знак після коми). `criteria` — лише ті, що мають ≥ 5 одиниць. */
export interface PublishedRatingDto {
  overall: number;
  units: number;
  criteria: Partial<Record<RatingCriterion, number>>;
}

/** `null` — ще немає опублікованого рейтингу (менше 5 одиниць). */
export interface UserRatingsDto {
  gm: PublishedRatingDto | null;
  playerFromGm: PublishedRatingDto | null;
  playerFromPlayer: PublishedRatingDto | null;
}
