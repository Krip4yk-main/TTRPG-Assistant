import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { createAppeal } from './appeals.service.js';

/** `/api/appeals` — без сесії: доступ лише за одноразовим токеном апеляції. */
export function appealsRouter(deps: AppDeps): Router {
  const router = Router();
  router.post('/', async (req, res) => {
    const { id } = await createAppeal(deps, req.body);
    res.status(201).json({ id });
  });
  return router;
}
