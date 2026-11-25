import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { gameId as numericId } from '../games/games.routes.js';
import { AppError } from '../http/errors.js';
import { pendingRatings, ratingTargets } from './ratings.eligibility.js';
import { submitRating } from './ratings.service.js';

const idOf = (req: { params: unknown }) => numericId((req.params as { id?: string }).id);

/** `?sessionId=` — додатне ціле або відсутній (підсумкові цілі). */
function sessionIdOf(raw: unknown): number | null {
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !/^[1-9]\d{0,14}$/.test(raw)) {
    throw new AppError(400, 'VALIDATION', { reason: 'INVALID_SESSION_ID' });
  }
  return Number(raw);
}

/** Монтується на `/api/games/:id/ratings`: цілі оцінювання й надсилання оцінки. */
export function gameRatingsRouter(deps: AppDeps): Router {
  const router = Router({ mergeParams: true });
  const auth = requireAuth(deps);
  router.get('/targets', auth, requireActive, async (req, res) => {
    const id = idOf(req);
    res.json(await ratingTargets(deps, req.user!.userId, id, sessionIdOf(req.query.sessionId)));
  });
  router.post('/', auth, requireActive, async (req, res) => {
    res.status(201).json(await submitRating(deps, req.user!.userId, idOf(req), req.body));
  });
  return router;
}

/** Монтується на `/api/me/ratings`: усі відкриті набори цілей для сторінки «Оцінити». */
export function myRatingsRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);
  router.get('/pending', auth, requireActive, async (req, res) => {
    res.json(await pendingRatings(deps, req.user!.userId));
  });
  return router;
}
