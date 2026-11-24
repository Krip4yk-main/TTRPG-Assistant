import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { gameId as numericId } from '../games/games.routes.js';
import { banMember, kickMember, leaveGame, listMembers } from './members.service.js';

/** Монтується на `/api/games/:id`: склад, вихід, виключення й бан у грі. */
export function gameMembersRouter(deps: AppDeps): Router {
  const router = Router({ mergeParams: true });
  const auth = requireAuth(deps);
  const id = (req: { params: unknown }) => numericId((req.params as { id?: string }).id);

  router.get('/members', auth, requireActive, async (req, res) => {
    res.json(await listMembers(deps, req.user!.userId, id(req)));
  });
  router.post('/leave', auth, requireActive, async (req, res) => {
    await leaveGame(deps, req.user!.userId, id(req), req.body);
    res.status(204).end();
  });
  router.post('/members/:publicId/kick', auth, requireActive, async (req, res) => {
    await kickMember(deps, req.user!.userId, id(req), String(req.params.publicId));
    res.status(204).end();
  });
  router.post('/members/:publicId/ban', auth, requireActive, async (req, res) => {
    await banMember(deps, req.user!.userId, id(req), String(req.params.publicId));
    res.status(204).end();
  });
  return router;
}
