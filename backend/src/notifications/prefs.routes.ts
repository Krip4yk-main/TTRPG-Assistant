import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { getPrefs, putPrefs } from './notifications.service.js';

/** Монтується на `/api/me/notification-prefs`. */
export function notificationPrefsRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);
  router.get('/', auth, requireActive, async (req, res) => {
    res.json(await getPrefs(deps, req.user!.userId));
  });
  router.put('/', auth, requireActive, async (req, res) => {
    res.json(await putPrefs(deps, req.user!.userId, req.body));
  });
  return router;
}
