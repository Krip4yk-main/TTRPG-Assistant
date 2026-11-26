import { Router } from 'express';
import type { AppDeps } from '../../app.js';
import { requireActive, requireAuth } from '../../auth/session.middleware.js';
import {
  deleteCalendarImport,
  getCalendarImport,
  putCalendarImport,
  syncCalendarImportNow,
} from './calendar-import.service.js';

/**
 * Монтується на `/api/me/calendar-import`: стан (`GET`), підключити/замінити посилання
 * (`PUT {url}`), відключити (`DELETE`), оновити зараз (`POST /sync`). Посилання не
 * повертається жодним із них.
 */
export function calendarImportRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);
  router.get('/', auth, async (req, res) => {
    res.json(await getCalendarImport(deps, req.user!.userId));
  });
  router.put('/', auth, requireActive, async (req, res) => {
    res.json(await putCalendarImport(deps, req.user!.userId, req.body));
  });
  router.delete('/', auth, requireActive, async (req, res) => {
    await deleteCalendarImport(deps, req.user!.userId);
    res.status(204).end();
  });
  router.post('/sync', auth, requireActive, async (req, res) => {
    res.json(await syncCalendarImportNow(deps, req.user!.userId));
  });
  return router;
}
