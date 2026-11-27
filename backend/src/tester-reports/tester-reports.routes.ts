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
 * Монтується на `/api/tester-reports` лише при `DEPLOY_ENV=dev` (інакше — 404): подання звіту.
 * Гості теж можуть (сесія необов'язкова); ліміт — `rateLimiters().testerReport`.
 */
export function testerReportsRouter(deps: AppDeps): Router {
  const router = Router();
  router.post('/', async (req, res) => {
    res.status(201).json(await submitTesterReport(deps, req.user?.userId ?? null, req.body));
  });
  return router;
}

/** Монтується на `/api/admin/tester-reports` лише при `DEPLOY_ENV=dev`: адмін і власник. */
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
