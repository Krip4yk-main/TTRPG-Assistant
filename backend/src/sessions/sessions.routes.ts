import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { gameId as numericId } from '../games/games.routes.js';
import {
  cancelSession,
  finishSession,
  listGameSessions,
  rescheduleSession,
} from './sessions.service.js';

/** Монтується на `/api/games/:id`: список сесій гри. */
export function gameSessionsRouter(deps: AppDeps): Router {
  const router = Router({ mergeParams: true });
  const auth = requireAuth(deps);
  router.get('/sessions', auth, requireActive, async (req, res) => {
    const id = numericId((req.params as { id?: string }).id);
    res.json(await listGameSessions(deps, req.user!.userId, id));
  });
  return router;
}

/** Монтується на `/api/sessions`: дії майстра над окремою сесією. */
export function sessionsRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);
  const actions = {
    reschedule: rescheduleSession,
    cancel: cancelSession,
    finish: finishSession,
  } as const;
  for (const [action, run] of Object.entries(actions)) {
    router.post(`/:id/${action}`, auth, requireActive, async (req, res) => {
      res.json(await run(deps, req.user!.userId, numericId(req.params.id), req.body));
    });
  }
  return router;
}
