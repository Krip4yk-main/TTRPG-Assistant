import { z } from 'zod';
import { ianaTimezone, isoDate } from './common.js';

export const completeProfileSchema = z.object({
  nickname: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[\p{L}\p{N}_.-]+$/u),
  birthDate: isoDate,
  timezone: ianaTimezone.optional(),
});
export const changeNicknameSchema = completeProfileSchema.pick({ nickname: true });
export type ChangeNicknameInput = z.infer<typeof changeNicknameSchema>;
export type CompleteProfileInput = z.infer<typeof completeProfileSchema>;

export const devLoginSchema = z.object({
  nickname: z.string().min(1),
  ownerKey: z.string().optional(),
});
export type DevLoginInput = z.infer<typeof devLoginSchema>;

/**
 * Dev-вхід на беті (`POST /api/auth/dev-login/code`): код доступу тестера + нікнейм.
 * Ключа власника немає — персонал так не входить. Нікнейм — за правилами профілю (сервер
 * доступний з інтернету: без пробілів, невидимих символів тощо).
 */
export const devCodeLoginSchema = z.object({
  code: z.string().min(1).max(256),
  nickname: completeProfileSchema.shape.nickname,
});
export type DevCodeLoginInput = z.infer<typeof devCodeLoginSchema>;
