import { z } from 'zod';
import type { UserRole } from './me.js';

/** Причини скарг (порядок — як у формі). */
export const COMPLAINT_REASONS = [
  'scam',
  'harassment',
  'no_show',
  'agreement_violation',
  'inappropriate_content',
  'other',
] as const;
export type ComplaintReason = (typeof COMPLAINT_REASONS)[number];

/** `new` — нерозглянута; `dismissed` — відхилена; `actioned` — вжито заходів (є санкція). */
export const COMPLAINT_STATUSES = ['new', 'dismissed', 'actioned'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

/**
 * Типи санкцій (від найм'якшої): `application_limit` — не більше 1 заявки в статусі `pending`;
 * `no_paid_apply` — не подаватись на платні ігри; `no_paid_create` — не створювати платні ігри
 * (і не робити наявну платною); `global_ban` — глобальний бан (вхід заборонено).
 */
export const SANCTION_TYPES = [
  'warning',
  'application_limit',
  'no_paid_apply',
  'no_paid_create',
  'global_ban',
] as const;
export type SanctionType = (typeof SANCTION_TYPES)[number];

/** Строк санкції; `permanent` — без кінця (`endsAt` = null). */
export const SANCTION_DURATIONS = ['7d', '30d', '90d', 'permanent'] as const;
export type SanctionDuration = (typeof SANCTION_DURATIONS)[number];

/** Тривалість у днях для строкових санкцій. */
export const SANCTION_DURATION_DAYS: Record<Exclude<SanctionDuration, 'permanent'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

/** Кінець санкції для строку `duration`, що починається в `startsAt`; `null` — назавжди. */
export function sanctionEndsAt(startsAt: Date, duration: SanctionDuration): Date | null {
  if (duration === 'permanent') return null;
  return new Date(startsAt.getTime() + SANCTION_DURATION_DAYS[duration] * 86_400_000);
}

export const SANCTION_APPEAL_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type SanctionAppealStatus = (typeof SANCTION_APPEAL_STATUSES)[number];

/** Стан модерації оцінки: `text_hidden` — текст прихований; `cancelled` — оцінку анульовано. */
export const RATING_MODERATION_STATES = ['none', 'text_hidden', 'cancelled'] as const;
export type RatingModerationState = (typeof RATING_MODERATION_STATES)[number];

/** Ролі, які можна призначити через `PUT /api/admin/users/:publicId/role` (власника — лише передачею). */
export const ASSIGNABLE_ROLES = ['user', 'moderator', 'admin'] as const satisfies UserRole[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const MODERATION_TEXT_MAX = 2000;

/** Обов'язковий текст ≤ 2000 після trim. */
const requiredText = z.string().trim().min(1).max(MODERATION_TEXT_MAX);
/** Необов'язковий текст ≤ 2000; порожній після trim → відсутній. */
const optionalText = z
  .string()
  .trim()
  .max(MODERATION_TEXT_MAX)
  .optional()
  .transform((v) => (v ? v : undefined));

/**
 * Тіло `POST /api/complaints`: рівно одна ціль — людина (`publicId`) або гра (id). Текст
 * необов'язковий (порожній → `''`).
 */
export const complaintInputSchema = z
  .object({
    targetUserId: z.string().min(1).max(32).optional(),
    targetGameId: z.number().int().positive().optional(),
    reason: z.enum(COMPLAINT_REASONS),
    message: z.string().trim().max(MODERATION_TEXT_MAX).default(''),
  })
  .strict()
  .refine((v) => (v.targetUserId === undefined) !== (v.targetGameId === undefined), {
    message: 'Exactly one of targetUserId, targetGameId is required',
    path: ['targetUserId'],
  });
export type ComplaintInput = z.input<typeof complaintInputSchema>;
export type ComplaintInputParsed = z.output<typeof complaintInputSchema>;

/** Санкція: тип, строк і причина (покараний її бачить). */
export const sanctionInputSchema = z
  .object({
    type: z.enum(SANCTION_TYPES),
    duration: z.enum(SANCTION_DURATIONS),
    reason: requiredText,
  })
  .strict();
export type SanctionInput = z.input<typeof sanctionInputSchema>;
export type SanctionInputParsed = z.output<typeof sanctionInputSchema>;

/**
 * Тіло `POST /api/me/sanctions/:id/appeal`. (Апеляція на бан через токен — наявний
 * `appealInputSchema` з `appeals.ts`.)
 */
export const sanctionAppealInputSchema = z.object({ message: requiredText }).strict();
export type SanctionAppealInput = z.input<typeof sanctionAppealInputSchema>;

/** `POST /api/admin/complaints/:id/dismiss`. */
export const complaintDismissSchema = z.object({ note: optionalText }).strict();
export type ComplaintDismissInput = z.input<typeof complaintDismissSchema>;

/** `POST /api/admin/complaints/:id/action`. */
export const complaintActionSchema = z.object({ sanction: sanctionInputSchema }).strict();
export type ComplaintActionInput = z.input<typeof complaintActionSchema>;

/** `POST /api/admin/sanctions/:id/lift`. */
export const sanctionLiftSchema = z.object({ note: optionalText }).strict();
export type SanctionLiftInput = z.input<typeof sanctionLiftSchema>;

/** `POST /api/admin/appeals/:id/decide`. */
export const appealDecisionSchema = z.object({ accept: z.boolean(), note: optionalText }).strict();
export type AppealDecisionInput = z.input<typeof appealDecisionSchema>;

/** `POST /api/admin/ratings/:id/hide-text` і `/cancel`. */
export const ratingModerationInputSchema = z.object({ reason: requiredText }).strict();
export type RatingModerationInput = z.input<typeof ratingModerationInputSchema>;

/** `PUT /api/admin/users/:publicId/role`. */
export const roleChangeSchema = z.object({ role: z.enum(ASSIGNABLE_ROLES) }).strict();
export type RoleChangeInput = z.input<typeof roleChangeSchema>;

/** `POST /api/admin/owner/transfer`: лише чинному адміну; нік — повторне підтвердження. */
export const ownerTransferSchema = z
  .object({
    toPublicId: z.string().min(1).max(32),
    confirmNickname: z.string().trim().min(1).max(32),
  })
  .strict();
export type OwnerTransferInput = z.input<typeof ownerTransferSchema>;

/** Користувач у відповідях адмінки; `null`-поля — видалений акаунт. */
export interface ModerationUserRefDto {
  publicId: string;
  nickname: string | null;
  role: UserRole;
}

/**
 * Скарга для персоналу. `reporter` — `null`, якщо переглядач не може бачити скаржника
 * (картка цілі для модератора — анонімність).
 */
export interface ComplaintDto {
  id: number;
  reporter: ModerationUserRefDto | null;
  targetUser: ModerationUserRefDto | null;
  targetGame: { id: number; title: string } | null;
  reason: ComplaintReason;
  message: string;
  status: ComplaintStatus;
  resolvedBy: ModerationUserRefDto | null;
  /** ISO 8601 UTC. */
  resolvedAt: string | null;
  sanctionId: number | null;
  createdAt: string;
}

/** Санкція для персоналу. `imposedBy`/`liftedBy` = null — система. */
export interface SanctionDto {
  id: number;
  user: ModerationUserRefDto;
  type: SanctionType;
  reason: string;
  imposedBy: ModerationUserRefDto | null;
  startsAt: string;
  /** `null` — назавжди. */
  endsAt: string | null;
  liftedAt: string | null;
  liftedBy: ModerationUserRefDto | null;
  complaintId: number | null;
  /** Чинна зараз (не знята й не закінчилась). */
  active: boolean;
  appealStatus: SanctionAppealStatus | null;
  createdAt: string;
}

/** Апеляція на санкцію для персоналу. */
export interface AppealDto {
  id: number;
  sanctionId: number;
  sanctionType: SanctionType;
  sanctionReason: string;
  sanctionEndsAt: string | null;
  user: ModerationUserRefDto;
  message: string;
  status: SanctionAppealStatus;
  decidedBy: ModerationUserRefDto | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

/** Картка користувача в адмінці. */
export interface AdminUserDto {
  publicId: string;
  nickname: string | null;
  avatarUrl: string | null;
  role: UserRole;
  status: 'pending' | 'active' | 'deleted';
  isBanned: boolean;
  createdAt: string;
  sanctions: SanctionDto[];
  /** Скарги на цю людину; `reporter` прихований для модераторів. */
  complaints: ComplaintDto[];
}

/** Рядок журналу дій адміністрації. `actor` = null — система. */
export interface ModerationLogDto {
  id: number;
  actor: ModerationUserRefDto | null;
  action: string;
  targetType: string;
  targetId: number;
  reason: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

/** Моя чинна санкція (`GET /api/me/sanctions`) — без даних про того, хто наклав. */
export interface MySanctionDto {
  id: number;
  type: SanctionType;
  reason: string;
  startsAt: string;
  endsAt: string | null;
  appealStatus: SanctionAppealStatus | null;
}

/** `details` помилки `SANCTION_ACTIVE` (409): яка санкція заважає й до коли. */
export interface SanctionActiveDetails {
  type: SanctionType;
  endsAt: string | null;
}

/** Сторінка списку адмінки; `nextCursor` = null — кінець. */
export interface AdminPageDto<T> {
  items: T[];
  nextCursor: number | null;
}
