import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { gameId as numericId } from '../games/games.routes.js';
import { appealMySanction, decideAppeal, listAppeals } from './appeals.service.js';
import type { StaffViewer } from './complaints.service.js';
import { requireStaff } from './permissions.js';
import { cancelRating, hideRatingText, listRatings } from './ratings-moderation.js';
import { adminUserCard, changeRole, searchUsers, transferOwner } from './roles.service.js';

const viewerOf = (req: { user?: { userId: number; role: StaffViewer['role'] } }): StaffViewer => ({
  userId: req.user!.userId,
  role: req.user!.role,
});
const idOf = (req: { params: unknown }) => numericId((req.params as { id?: string }).id);

/** Монтується на `/api/me/sanctions`: апеляція на мою чинну санкцію. */
export function mySanctionAppealsRouter(deps: AppDeps): Router {
  const router = Router();
  router.post('/:id/appeal', requireAuth(deps), requireActive, async (req, res) => {
    res.status(201).json(await appealMySanction(deps, req.user!.userId, idOf(req), req.body));
  });
  return router;
}

/**
 * Монтується на `/api/admin`: апеляції, черга «Відгуки», користувачі, ролі й передача прав
 * власника. Мінімальна роль — на маршруті (`requireStaff`, з кешу сесії); точні права (тип
 * санкції, ранг цілі, роль з БД) перевіряють сервіси.
 */
export function adminRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);
  const mod = [auth, requireStaff('moderator')];
  const admin = [auth, requireStaff('admin')];

  router.get('/appeals', ...mod, async (req, res) => {
    res.json(await listAppeals(deps, viewerOf(req), req.query));
  });
  router.post('/appeals/:id/decide', ...mod, async (req, res) => {
    res.json(await decideAppeal(deps, req.user!.userId, idOf(req), req.body));
  });

  router.get('/ratings', ...mod, async (req, res) => {
    res.json(await listRatings(deps, viewerOf(req), req.query));
  });
  router.post('/ratings/:id/hide-text', ...mod, async (req, res) => {
    res.json(await hideRatingText(deps, req.user!.userId, idOf(req), req.body));
  });
  router.post('/ratings/:id/cancel', ...mod, async (req, res) => {
    res.json(await cancelRating(deps, req.user!.userId, idOf(req), req.body));
  });

  router.get('/users', ...mod, async (req, res) => {
    res.json(await searchUsers(deps, viewerOf(req), req.query));
  });
  router.get('/users/:publicId', ...mod, async (req, res) => {
    res.json(await adminUserCard(deps, viewerOf(req), String(req.params.publicId)));
  });
  router.put('/users/:publicId/role', ...admin, async (req, res) => {
    res.json(await changeRole(deps, req.user!.userId, String(req.params.publicId), req.body));
  });
  router.post('/owner/transfer', auth, requireStaff('owner'), async (req, res) => {
    res.json(await transferOwner(deps, req.user!.userId, req.body));
  });
  return router;
}
