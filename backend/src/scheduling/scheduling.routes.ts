import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { gameId as numericId } from '../games/games.routes.js';
import { getCommonTimes } from './common-times.service.js';

/** Монтується на `/api/games/:id`: підбір спільного часу групи (лише майстер). */
export function gameSchedulingRouter(deps: AppDeps): Router {
  const router = Router({ mergeParams: true });
  const auth = requireAuth(deps);
  router.get('/common-times', auth, requireActive, async (req, res) => {
    const id = numericId((req.params as { id?: string }).id);
    res.json(await getCommonTimes(deps, req.user!.userId, id, req.query));
  });
  return router;
}
