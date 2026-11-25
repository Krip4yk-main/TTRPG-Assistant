import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { gameId as numericId } from '../games/games.routes.js';
import {
  actionComplaint,
  dismissComplaint,
  listComplaints,
  submitComplaint,
  type StaffViewer,
} from './complaints.service.js';
import { requireStaff } from './permissions.js';

/** Монтується на `/api/complaints`: подання скарги. */
export function complaintsRouter(deps: AppDeps): Router {
  const router = Router();
  router.post('/', requireAuth(deps), requireActive, async (req, res) => {
    res.status(201).json(await submitComplaint(deps, req.user!.userId, req.body));
  });
  return router;
}

const viewerOf = (req: { user?: { userId: number; role: StaffViewer['role'] } }): StaffViewer => ({
  userId: req.user!.userId,
  role: req.user!.role,
});
const idOf = (req: { params: unknown }) => numericId((req.params as { id?: string }).id);

/** Монтується на `/api/admin/complaints`: черга скарг для персоналу (модератор+). */
export function adminComplaintsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireAuth(deps), requireStaff('moderator'));
  router.get('/', async (req, res) => {
    res.json(await listComplaints(deps, viewerOf(req), req.query));
  });
  router.post('/:id/dismiss', async (req, res) => {
    res.json(await dismissComplaint(deps, viewerOf(req), idOf(req), req.body));
  });
  router.post('/:id/action', async (req, res) => {
    res.json(await actionComplaint(deps, viewerOf(req), idOf(req), req.body));
  });
  return router;
}
