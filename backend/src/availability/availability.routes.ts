import { Router } from 'express';
import { availabilityUpdateSchema } from '@nri/shared';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { getAvailability, replaceAvailability } from './availability.service.js';

/**
 * Монтується на `/api/me/availability`. Лише власний календар; `timezone` у відповіді —
 * пояс акаунта, у тілі `PUT` ігнорується.
 */
export function availabilityRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);
  router.get('/', auth, async (req, res) => {
    res.json(await getAvailability(deps, req.user!.userId));
  });
  router.put('/', auth, requireActive, async (req, res) => {
    const input = availabilityUpdateSchema.parse(req.body);
    res.json(await replaceAvailability(deps, req.user!.userId, input));
  });
  return router;
}
