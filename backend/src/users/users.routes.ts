import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  changeNicknameSchema,
  changeTimezoneSchema,
  completeProfileSchema,
  updateAvatarSchema,
  updateDefaultViewSchema,
  updateMyLimitsSchema,
  updateThemeSchema,
  updateUiPrefsSchema,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { clearSessionCookie } from '../auth/session.service.js';
import { authIdentities } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import { TG_LINK_PREFIX } from '../internal/internal.routes.js';
import {
  changeAvatar,
  changeBirthDate,
  changeDefaultView,
  changeNickname,
  changeTheme,
  changeUiPrefs,
  changeTimezone,
  completeProfile,
  changeMyLimits,
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

  router.patch('/nickname', auth, requireActive, async (req, res) => {
    const { nickname } = changeNicknameSchema.parse(req.body);
    res.json(await changeNickname(deps, req.user!.userId, nickname));
  });

  router.patch('/timezone', auth, requireActive, async (req, res) => {
    const { timezone } = changeTimezoneSchema.parse(req.body);
    res.json(await changeTimezone(deps, req.user!.userId, timezone));
  });

  router.put('/avatar', auth, requireActive, async (req, res) => {
    const input = updateAvatarSchema.parse(req.body);
    res.json(await changeAvatar(deps, req.user!.userId, input));
  });

  router.put('/limits', auth, requireActive, async (req, res) => {
    const { limits } = updateMyLimitsSchema.parse(req.body);
    res.json(await changeMyLimits(deps, req.user!.userId, limits));
  });

  router.patch('/theme', auth, requireActive, async (req, res) => {
    const { theme } = updateThemeSchema.parse(req.body);
    res.json(await changeTheme(deps, req.user!.userId, theme));
  });

  router.patch('/ui-prefs', auth, requireActive, async (req, res) => {
    const prefs = updateUiPrefsSchema.parse(req.body);
    res.json(await changeUiPrefs(deps, req.user!.userId, prefs));
  });

  router.patch('/default-view', auth, requireActive, async (req, res) => {
    const { defaultView } = updateDefaultViewSchema.parse(req.body);
    res.json(await changeDefaultView(deps, req.user!.userId, defaultView));
  });

  router.post('/telegram-link-token', auth, requireActive, async (req, res) => {
    const bot = deps.env.TELEGRAM_BOT_USERNAME;
    if (!bot) throw new AppError(404, 'NOT_FOUND');
    const token = randomBytes(16).toString('base64url');
    await deps.redis.set(`${TG_LINK_PREFIX}${token}`, String(req.user!.userId), 'EX', 600);
    res.json({ url: `https://t.me/${bot}?start=${token}` });
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
