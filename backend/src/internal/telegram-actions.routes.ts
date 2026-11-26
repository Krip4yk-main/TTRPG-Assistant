import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { telegramActionSchema, type TelegramActionResult } from '@nri/shared';
import type { AppDeps } from '../app.js';
import { approveApplication, rejectApplication } from '../applications/applications.service.js';
import { authIdentities, gameApplications, users } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import { pollIdOfOption, vote } from '../scheduling/polls.service.js';
import { setRsvp } from '../sessions/rsvp.js';

type Decision = 'approved' | 'rejected';

/**
 * Користувач за Telegram-ідентичністю: невідомий id → 404 `NOT_FOUND`
 * (`details.reason = 'NOT_LINKED'`), заблокований → 403 `ACCOUNT_BANNED`, неактивний → 403
 * `PROFILE_INCOMPLETE` (як `requireActive` у вебі).
 */
async function actorOf(deps: AppDeps, telegramId: string | number): Promise<number> {
  const [u] = await deps.db
    .select({ id: users.id, status: users.status, isBanned: users.isBanned })
    .from(authIdentities)
    .innerJoin(users, eq(users.id, authIdentities.userId))
    .where(
      and(eq(authIdentities.provider, 'telegram'), eq(authIdentities.subject, String(telegramId))),
    );
  if (!u || u.status === 'deleted') throw new AppError(404, 'NOT_FOUND', { reason: 'NOT_LINKED' });
  if (u.isBanned) throw new AppError(403, 'ACCOUNT_BANNED');
  if (u.status !== 'active') throw new AppError(403, 'PROFILE_INCOMPLETE');
  return u.id;
}

/**
 * Рішення по заявці тими самими функціями, що й у вебі (права майстра перевіряє сервіс:
 * чужа заявка → 403, неіснуюча → 404). Повторне натискання (заявка вже затверджена чи
 * відхилена — зокрема з сайту) не є помилкою: повертається поточний стан. Відкликана чи
 * скасована заявка — 409 `APPLICATION_CLOSED`.
 */
async function decide(
  deps: AppDeps,
  userId: number,
  id: number,
  action: 'approve' | 'reject',
): Promise<Decision> {
  try {
    if (action === 'approve') await approveApplication(deps, userId, id);
    else await rejectApplication(deps, userId, id);
    return action === 'approve' ? 'approved' : 'rejected';
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'APPLICATION_CLOSED') throw err;
    // До 409 сервіс уже перевірив, що це заявка гри цього майстра.
    const [row] = await deps.db
      .select({ status: gameApplications.status })
      .from(gameApplications)
      .where(eq(gameApplications.id, id));
    if (row?.status === 'approved' || row?.status === 'rejected') return row.status;
    throw err;
  }
}

/**
 * `POST /api/internal/telegram/action` (бот, за `requireInternalKey`): дія з кнопки
 * сповіщення від імені користувача, чий Telegram натиснув кнопку.
 */
export function telegramActionsRouter(deps: AppDeps): Router {
  const router = Router();
  router.post('/', async (req, res) => {
    const input = telegramActionSchema.parse(req.body);
    const userId = await actorOf(deps, input.telegramId);
    let result: TelegramActionResult['result'];
    if (input.action === 'rsvp') {
      result = await setRsvp(deps, userId, input.id, { status: input.value });
    } else if (input.action === 'vote') {
      // `id` — варіант голосування; членство, відкритість і належність варіанта перевіряє `vote`.
      const value = input.value as 'yes' | 'no' | 'maybe';
      await vote(deps, userId, await pollIdOfOption(deps, input.id), {
        votes: [{ optionId: input.id, value }],
      });
      result = `vote_${value}`;
    } else {
      result = await decide(deps, userId, input.id, input.action);
    }
    res.json({ ok: true, result } satisfies TelegramActionResult);
  });
  return router;
}
