import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { addToBlacklist, listBlacklist, removeFromBlacklist } from './members.service.js';

/** Монтується на `/api/me/blacklist`: чорний список майстра. */
export function blacklistRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);
  router.get('/', auth, requireActive, async (req, res) => {
    res.json(await listBlacklist(deps, req.user!.userId));
  });
  router.post('/:publicId', auth, requireActive, async (req, res) => {
    res.status(201).json(await addToBlacklist(deps, req.user!.userId, String(req.params.publicId)));
  });
  router.delete('/:publicId', auth, requireActive, async (req, res) => {
    await removeFromBlacklist(deps, req.user!.userId, String(req.params.publicId));
    res.status(204).end();
  });
  return router;
}
