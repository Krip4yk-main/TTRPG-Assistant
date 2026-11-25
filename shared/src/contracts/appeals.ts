import { z } from 'zod';
import type { SanctionAppealStatus } from './moderation.js';

export const APPEAL_MESSAGE_MAX = 2000;

/** Тіло `POST /api/appeals`. */
export const appealInputSchema = z
  .object({
    appealToken: z.string().min(1).max(128),
    message: z.string().trim().min(1).max(APPEAL_MESSAGE_MAX),
  })
  .strict();
export type AppealInput = z.input<typeof appealInputSchema>;

/** `details` помилки `ACCOUNT_BANNED` при вході. */
export interface BannedLoginDetails {
  appealToken: string;
  /** Апеляцію на чинний бан уже подано (`appealStatus` не null). */
  appealSent: boolean;
  /** Статус апеляції на чинний бан; `null` — ще не подано. */
  appealStatus?: SanctionAppealStatus | null;
}
