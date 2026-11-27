import { Router, type RequestHandler } from 'express';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { AppError } from '../http/errors.js';
import {
  deleteCalendarFeed,
  getCalendarFeed,
  issueCalendarFeed,
  renderCalendarFeed,
} from './calendar-feed.service.js';

/** Календарі перевіряють підписку не частіше ніж раз на годину. */
const FEED_CACHE = 'private, max-age=3600';

/**
 * Публічний фід `GET /api/cal/<token>.ics`: без cookie, CSRF і сесії (монтується до них),
 * під власними лімітами. Будь-яка невідповідність — 404 без подробиць.
 */
export function calendarFeedPublicRouter(
  deps: AppDeps,
  limits: { ip: RequestHandler; token: RequestHandler },
): Router {
  const router = Router();
  router.get('/api/cal/:file', limits.ip, limits.token, async (req, res) => {
    const ics = await renderCalendarFeed(deps, String(req.params.file));
    if (ics === null) throw new AppError(404, 'NOT_FOUND');
    res
      .status(200)
      .set('Cache-Control', FEED_CACHE)
      .set('Content-Type', 'text/calendar; charset=utf-8')
      .send(ics);
  });
  return router;
}

/** Монтується на `/api/me/calendar-feed`: стан, створити/перевипустити, вимкнути. */
export function calendarFeedRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);
  router.get('/', auth, async (req, res) => {
    res.json(await getCalendarFeed(deps, req.user!.userId));
  });
  router.post('/', auth, requireActive, async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await issueCalendarFeed(deps, req.user!.userId));
  });
  router.delete('/', auth, requireActive, async (req, res) => {
    await deleteCalendarFeed(deps, req.user!.userId);
    res.status(204).end();
  });
  return router;
}
