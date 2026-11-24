import { Router } from 'express';
import { profileInputSchema } from '@nri/shared';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { getOwnProfile, getPublicProfile, updateProfile } from './profiles.service.js';

/** Монтується на `/api/me/profile`. */
export function profileRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);
  router.get('/', auth, async (req, res) => {
    res.json(await getOwnProfile(deps, req.user!.userId));
  });
  router.patch('/', auth, requireActive, async (req, res) => {
    const patch = profileInputSchema.parse(req.body);
    res.json(await updateProfile(deps, req.user!.userId, patch));
  });
  return router;
}

/** Монтується на `/api/users`. Публічний. */
export function publicUsersRouter(deps: AppDeps): Router {
  const router = Router();
  router.get('/:publicId', async (req, res) => {
    res.json(await getPublicProfile(deps, String(req.params.publicId)));
  });
  return router;
}
