import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { gameId as numericId } from '../games/games.routes.js';
import {
  approveApplication,
  createApplication,
  listGameApplications,
  listMyApplications,
  rejectApplication,
  respondToConstraint,
  withdrawApplication,
} from './applications.service.js';

/** Монтується на `/api/games/:id/applications`. */
export function gameApplicationsRouter(deps: AppDeps): Router {
  const router = Router({ mergeParams: true });
  const auth = requireAuth(deps);
  router.post('/', auth, requireActive, async (req, res) => {
    const id = numericId((req.params as { id?: string }).id);
    res.status(201).json(await createApplication(deps, req.user!.userId, id, req.body));
  });
  router.get('/', auth, requireActive, async (req, res) => {
    const id = numericId((req.params as { id?: string }).id);
    res.json(await listGameApplications(deps, req.user!.userId, id));
  });
  return router;
}

/** Монтується на `/api/applications`. */
export function applicationsRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);
  router.delete('/:id', auth, requireActive, async (req, res) => {
    res.json(await withdrawApplication(deps, req.user!.userId, numericId(req.params.id)));
  });
  router.post('/:id/approve', auth, requireActive, async (req, res) => {
    res.json(await approveApplication(deps, req.user!.userId, numericId(req.params.id)));
  });
  router.post('/:id/reject', auth, requireActive, async (req, res) => {
    res.json(await rejectApplication(deps, req.user!.userId, numericId(req.params.id)));
  });
  router.put('/:id/constraints/:constraintId', auth, requireActive, async (req, res) => {
    res.json(
      await respondToConstraint(
        deps,
        req.user!.userId,
        numericId(req.params.id),
        String(req.params.constraintId),
        req.body,
      ),
    );
  });
  return router;
}

/** Монтується на `/api/me/applications`. */
export function myApplicationsRouter(deps: AppDeps): Router {
  const router = Router();
  router.get('/', requireAuth(deps), requireActive, async (req, res) => {
    res.json(await listMyApplications(deps, req.user!.userId));
  });
  return router;
}
