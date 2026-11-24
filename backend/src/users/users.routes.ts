import { Router } from 'express';
import { z } from 'zod';
import { completeProfileSchema } from '@nri/shared';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { clearSessionCookie } from '../auth/session.service.js';
import { authIdentities } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import {
  changeBirthDate,
  completeProfile,
  deleteAccount,
  getMe,
  unlinkIdentity,
} from './users.service.js';

const birthDateBody = completeProfileSchema.pick({ birthDate: true });
const providerParam = z.enum(authIdentities.provider.enumValues);

/** Монтується на `/api/me`. */
export function usersRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);

  router.get('/', auth, async (req, res) => {
    res.json(await getMe(deps, req.user!.userId));
  });

  router.post('/complete-profile', auth, async (req, res) => {
    const input = completeProfileSchema.parse(req.body);
    if (req.user!.status !== 'pending') {
      throw new AppError(400, 'VALIDATION', { reason: 'ALREADY_ACTIVE' });
    }
    const result = await completeProfile(deps, req.user!.userId, input);
    if (!result.ok) {
      clearSessionCookie(res);
      throw new AppError(422, 'AGE_TOO_LOW');
    }
    res.json(await getMe(deps, req.user!.userId));
  });

  router.patch('/birth-date', auth, requireActive, async (req, res) => {
    const { birthDate } = birthDateBody.parse(req.body);
    await changeBirthDate(deps, req.user!.userId, birthDate);
    res.json(await getMe(deps, req.user!.userId));
  });

  router.delete('/identities/:provider', auth, async (req, res) => {
    const provider = providerParam.parse(req.params.provider);
    await unlinkIdentity(deps, req.user!.userId, provider);
    const me = await getMe(deps, req.user!.userId);
    res.json({ identities: me.identities });
  });

  router.delete('/', auth, async (req, res) => {
    await deleteAccount(deps, req.user!.userId);
    clearSessionCookie(res);
    res.status(204).end();
  });

  return router;
}
