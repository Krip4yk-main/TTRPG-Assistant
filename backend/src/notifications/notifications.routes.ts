import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { gameId as numericId } from '../games/games.routes.js';
import { listNotifications, markAllRead, markRead, unreadCount } from './notifications.service.js';

/** Монтується на `/api/me/notifications`. */
export function notificationsRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);
  router.get('/', auth, requireActive, async (req, res) => {
    res.json(await listNotifications(deps, req.user!.userId, req.query));
  });
  router.get('/unread-count', auth, requireActive, async (req, res) => {
    res.json(await unreadCount(deps, req.user!.userId));
  });
  router.post('/read-all', auth, requireActive, async (req, res) => {
    await markAllRead(deps, req.user!.userId);
    res.status(204).end();
  });
  router.post('/:id/read', auth, requireActive, async (req, res) => {
    res.json(await markRead(deps, req.user!.userId, numericId(req.params.id)));
  });
  return router;
}
