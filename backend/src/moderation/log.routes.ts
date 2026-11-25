import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireAuth } from '../auth/session.middleware.js';
import { listLog } from './log.js';
import { requireStaff } from './permissions.js';

/** Монтується на `/api/admin/log`: журнал дій адміністрації (адмін+). */
export function adminLogRouter(deps: AppDeps): Router {
  const router = Router();
  router.get('/', requireAuth(deps), requireStaff('admin'), async (req, res) => {
    res.json(await listLog(deps.db, req.user!.role, req.query));
  });
  return router;
}
