import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { gameId as numericId } from '../games/games.routes.js';
import { getCommonTimes } from './common-times.service.js';
import {
  applyPoll,
  closePollByGm,
  createPoll,
  getPoll,
  listGamePolls,
  vote,
} from './polls.service.js';

/**
 * Монтується на `/api/games/:id`: підбір спільного часу групи (лише майстер) і голосування
 * за час (створює майстер, бачать майстер і активні учасники).
 */
export function gameSchedulingRouter(deps: AppDeps): Router {
  const router = Router({ mergeParams: true });
  const auth = requireAuth(deps);
  const gid = (req: { params: unknown }) => numericId((req.params as { id?: string }).id);
  router.get('/common-times', auth, requireActive, async (req, res) => {
    res.json(await getCommonTimes(deps, req.user!.userId, gid(req), req.query));
  });
  router.get('/polls', auth, requireActive, async (req, res) => {
    res.json(await listGamePolls(deps, req.user!.userId, gid(req)));
  });
  router.post('/polls', auth, requireActive, async (req, res) => {
    res.status(201).json(await createPoll(deps, req.user!.userId, gid(req), req.body));
  });
  return router;
}

/** Монтується на `/api/polls`: перегляд, відповідь учасника, закриття й застосування майстром. */
export function pollsRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);
  router.get('/:id', auth, requireActive, async (req, res) => {
    res.json(await getPoll(deps, req.user!.userId, numericId(req.params.id)));
  });
  router.put('/:id/votes', auth, requireActive, async (req, res) => {
    res.json(await vote(deps, req.user!.userId, numericId(req.params.id), req.body));
  });
  router.post('/:id/close', auth, requireActive, async (req, res) => {
    res.json(await closePollByGm(deps, req.user!.userId, numericId(req.params.id)));
  });
  router.post('/:id/apply', auth, requireActive, async (req, res) => {
    res.json(await applyPoll(deps, req.user!.userId, numericId(req.params.id), req.body));
  });
  return router;
}
