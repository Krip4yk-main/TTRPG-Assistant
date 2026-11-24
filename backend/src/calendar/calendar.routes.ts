import { Router } from 'express';
import { calendarSettingsPatchSchema, gameBusyQuerySchema } from '@nri/shared';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import {
  getCalendarSettings,
  updateCalendarSettings,
} from '../availability/availability.service.js';
import { gameId as numericId } from '../games/games.routes.js';
import { gameBusy, listPinnedGames, pinGame, unpinGame } from './game-busy.service.js';

/**
 * Монтується на `/api/me`: налаштування календаря (`/settings`), закріплені ігри
 * (`/calendar/pinned-games`) і зайнятість від ігор (`/calendar/game-busy`).
 */
export function calendarRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);
  router.get('/settings', auth, async (req, res) => {
    res.json(await getCalendarSettings(deps, req.user!.userId));
  });
  router.patch('/settings', auth, requireActive, async (req, res) => {
    const patch = calendarSettingsPatchSchema.parse(req.body);
    res.json(await updateCalendarSettings(deps, req.user!.userId, patch));
  });
  router.get('/calendar/game-busy', auth, async (req, res) => {
    const { from, to } = gameBusyQuerySchema.parse(req.query);
    res.json(await gameBusy(deps, req.user!.userId, from, to));
  });
  router.get('/calendar/pinned-games', auth, async (req, res) => {
    res.json(await listPinnedGames(deps, req.user!.userId));
  });
  router.post('/calendar/pinned-games/:gameId', auth, requireActive, async (req, res) => {
    await pinGame(deps, req.user!.userId, numericId(req.params.gameId));
    res.status(204).end();
  });
  router.delete('/calendar/pinned-games/:gameId', auth, requireActive, async (req, res) => {
    await unpinGame(deps, req.user!.userId, numericId(req.params.gameId));
    res.status(204).end();
  });
  return router;
}
