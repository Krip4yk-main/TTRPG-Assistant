import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { getCatalog } from './catalog.service.js';

/** Монтується на `/api/catalog`. Публічний. */
export function catalogRouter(deps: AppDeps): Router {
  const router = Router();
  router.get('/', async (_req, res) => {
    res.json(await getCatalog(deps));
  });
  return router;
}
