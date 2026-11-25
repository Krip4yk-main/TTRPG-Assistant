import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { markViewedByUser } from './views.service.js';

/** Монтується на `/api/me/views`: позначити показані сутності переглянутими. */
export function viewsRouter(deps: AppDeps): Router {
  const router = Router();
  router.post('/', requireAuth(deps), requireActive, async (req, res) => {
    await markViewedByUser(deps, req.user!.userId, req.body);
    res.status(204).end();
  });
  return router;
}
