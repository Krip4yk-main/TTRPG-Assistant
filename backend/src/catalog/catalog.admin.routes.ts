import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireAuth } from '../auth/session.middleware.js';
import { gameId as numericId } from '../games/games.routes.js';
import { requireStaff } from '../moderation/permissions.js';
import { createAdminSystem, listAdminSystems, patchAdminSystem } from './catalog.service.js';

/**
 * Монтується на `/api/admin/catalog` (адмін+, `catalog.edit`): системи каталогу. Роль на
 * маршруті — з кешу сесії; сервіс перевіряє її ще раз за БД. Зміни пишуть журнал
 * `catalog.*` і скидають кеш `GET /api/catalog`.
 */
export function adminCatalogRouter(deps: AppDeps): Router {
  const router = Router();
  const admin = [requireAuth(deps), requireStaff('admin')];

  router.get('/systems', ...admin, async (req, res) => {
    res.json(await listAdminSystems(deps, req.user!.userId));
  });
  router.post('/systems', ...admin, async (req, res) => {
    res.status(201).json(await createAdminSystem(deps, req.user!.userId, req.body));
  });
  router.patch('/systems/:id', ...admin, async (req, res) => {
    res.json(await patchAdminSystem(deps, req.user!.userId, numericId(req.params.id), req.body));
  });
  return router;
}
