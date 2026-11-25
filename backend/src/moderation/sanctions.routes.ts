import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireAuth } from '../auth/session.middleware.js';
import { gameId as numericId } from '../games/games.routes.js';
import { requireStaff } from './permissions.js';
import {
  imposeSanction,
  liftSanction,
  mySanctions,
  userIdByPublicId,
} from './sanctions.service.js';

/** Монтується на `/api/me/sanctions`: мої чинні санкції. */
export function mySanctionsRouter(deps: AppDeps): Router {
  const router = Router();
  router.get('/', requireAuth(deps), async (req, res) => {
    res.json(await mySanctions(deps, req.user!.userId));
  });
  return router;
}

/**
 * Монтується на `/api/admin`: накладення санкції користувачу й дострокове зняття
 * (модератор+; бан — адмін+, перевіряє сервіс). Middleware — на маршрутах, не на всьому
 * `/api/admin` (інші розділи адмінки мають власні роутери).
 */
export function adminSanctionsRouter(deps: AppDeps): Router {
  const router = Router();
  const staff = [requireAuth(deps), requireStaff('moderator')];
  router.post('/users/:publicId/sanctions', ...staff, async (req, res) => {
    const userId = await userIdByPublicId(deps.db, String(req.params.publicId));
    res.status(201).json(await imposeSanction(deps, req.user!.userId, userId, req.body));
  });
  router.post('/sanctions/:id/lift', ...staff, async (req, res) => {
    res.json(await liftSanction(deps, req.user!.userId, numericId(req.params.id), req.body));
  });
  return router;
}
