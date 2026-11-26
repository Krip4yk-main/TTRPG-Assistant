import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { gameId as numericId } from '../games/games.routes.js';
import {
  cancelSession,
  finishSession,
  listGameSessions,
  reload,
  rescheduleSession,
} from './sessions.service.js';
import { setRsvp } from './rsvp.js';
import { getSessionAlternatives } from '../scheduling/reschedule.service.js';

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

/** Монтується на `/api/sessions`: дії майстра над окремою сесією та RSVP учасника. */
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
  // Розумне перенесення: альтернативи на тижні сесії (лише майстер).
  router.get('/:id/alternatives', auth, requireActive, async (req, res) => {
    res.json(await getSessionAlternatives(deps, req.user!.userId, numericId(req.params.id)));
  });
  router.put('/:id/rsvp', auth, requireActive, async (req, res) => {
    const id = numericId(req.params.id);
    await setRsvp(deps, req.user!.userId, id, req.body);
    res.json(await reload(deps, req.user!.userId, id));
  });
  return router;
}
