import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireAuth } from '../auth/session.middleware.js';
import { gameId as numericId } from '../games/games.routes.js';
import { requireStaff } from '../moderation/permissions.js';
import {
  listTesterReports,
  markTesterReportProcessed,
  submitTesterReport,
} from './tester-reports.service.js';

/**
 * Монтується на `/api/tester-reports` у всіх середовищах: подання відгуку. На dev гості теж
 * можуть (ліміт — `rateLimiters().testerReport`, з IP); поза dev (prod, local) — лише авторизовані
 * (гість → 401), ліміт `rateLimiters().feedback` — 2 на добу на користувача.
 */
export function testerReportsRouter(deps: AppDeps): Router {
  const router = Router();
  if (deps.env.DEPLOY_ENV !== 'dev') router.use(requireAuth(deps));
  router.post('/', async (req, res) => {
    res.status(201).json(await submitTesterReport(deps, req.user?.userId ?? null, req.body));
  });
  return router;
}

/** Монтується на `/api/admin/tester-reports` у всіх середовищах: адмін і власник. */
export function adminTesterReportsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireAuth(deps), requireStaff('admin'));
  router.get('/', async (req, res) => {
    res.json(await listTesterReports(deps, req.query));
  });
  router.post('/:id/processed', async (req, res) => {
    const id = numericId((req.params as { id?: string }).id);
    res.json(await markTesterReportProcessed(deps, req.user!.userId, id));
  });
  return router;
}
