import { Router } from 'express';
import type { AppDeps } from '../../app.js';
import { requireActive, requireAuth } from '../../auth/session.middleware.js';
import { requireStaff } from '../../moderation/permissions.js';
import { gameId } from '../games.routes.js';
import {
  adminCloseDeadGame,
  adminDismissDeadGame,
  closeDead,
  listAdminDeadGames,
  listMyDeadGames,
  stillAlive,
} from './dead-games.service.js';

/** Монтується на `/api/games`: дії майстра над «мертвою» грою. */
export function deadGamesRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);
  router.post('/:id/still-alive', auth, requireActive, async (req, res) => {
    res.json(await stillAlive(deps, req.user!.userId, gameId(req.params.id)));
  });
  router.post('/:id/close-dead', auth, requireActive, async (req, res) => {
    res.json(await closeDead(deps, req.user!.userId, gameId(req.params.id)));
  });
  return router;
}

/** Монтується на `/api/me/dead-games`: позначені ігри майстра (форма створення, «Мої ігри»). */
export function myDeadGamesRouter(deps: AppDeps): Router {
  const router = Router();
  router.get('/', requireAuth(deps), requireActive, async (req, res) => {
    res.json(await listMyDeadGames(deps, req.user!.userId));
  });
  return router;
}

/** Монтується на `/api/admin/dead-games` (модератор+; роль для дій — з БД). */
export function adminDeadGamesRouter(deps: AppDeps): Router {
  const router = Router();
  const mod = [requireAuth(deps), requireStaff('moderator')];
  router.get('/', ...mod, async (req, res) => {
    const viewer = { userId: req.user!.userId, role: req.user!.role };
    res.json(await listAdminDeadGames(deps, viewer, req.query));
  });
  router.post('/:id/close', ...mod, async (req, res) => {
    res.json(await adminCloseDeadGame(deps, req.user!.userId, gameId(req.params.id), req.body));
  });
  router.post('/:id/dismiss', ...mod, async (req, res) => {
    res.json(await adminDismissDeadGame(deps, req.user!.userId, gameId(req.params.id), req.body));
  });
  return router;
}
