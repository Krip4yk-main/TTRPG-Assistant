import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { gameId as numericId } from '../games/games.routes.js';
import {
  deleteNotification,
  deleteReadNotifications,
  listNotifications,
  markAllRead,
  markRead,
  unreadCount,
} from './notifications.service.js';

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
  // `/read` — раніше за `/:id`, щоб «read» не потрапило в параметр.
  router.delete('/read', auth, requireActive, async (req, res) => {
    res.json(await deleteReadNotifications(deps, req.user!.userId));
  });
  router.delete('/:id', auth, requireActive, async (req, res) => {
    await deleteNotification(deps, req.user!.userId, numericId(req.params.id));
    res.status(204).end();
  });
  return router;
}
