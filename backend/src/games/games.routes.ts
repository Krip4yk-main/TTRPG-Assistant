import { Router } from 'express';
import { GAME_ACTIONS } from '@nri/shared';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { AppError } from '../http/errors.js';
import { searchGames } from './games.search.js';
import {
  changeScheduleRule,
  createGame,
  getGameView,
  listMyGames,
  resolveViewer,
  transitionGame,
  updateGame,
} from './games.service.js';

/** Числовий id з параметра маршруту; інакше 404. */
export function gameId(raw: unknown): number {
  const s = String(raw);
  if (!/^\d{1,15}$/.test(s)) throw new AppError(404, 'NOT_FOUND');
  return Number(s);
}

/** Монтується на `/api/games`. */
export function gamesRouter(deps: AppDeps): Router {
  const router = Router();
  const auth = requireAuth(deps);

  router.post('/', auth, requireActive, async (req, res) => {
    res.status(201).json(await createGame(deps, req.user!.userId, req.body));
  });
  // Публічний пошук; `calendar.mode = 'mine'` вимагає сесії (перевіряє сервіс).
  router.post('/search', async (req, res) => {
    res.json(await searchGames(deps, req.user, req.body));
  });
  router.get('/mine', auth, requireActive, async (req, res) => {
    res.json(await listMyGames(deps, req.user!.userId));
  });
  router.get('/:id', async (req, res) => {
    const viewer = await resolveViewer(deps, req.user);
    res.json(await getGameView(deps, viewer, gameId(req.params.id)));
  });
  router.patch('/:id', auth, requireActive, async (req, res) => {
    res.json(await updateGame(deps, req.user!.userId, gameId(req.params.id), req.body));
  });
  router.put('/:id/schedule', auth, requireActive, async (req, res) => {
    const id = gameId(req.params.id);
    res.json(await changeScheduleRule(deps, req.user!.userId, id, req.body, 'schedule'));
  });
  router.post('/:id/convert-to-campaign', auth, requireActive, async (req, res) => {
    const id = gameId(req.params.id);
    res.json(await changeScheduleRule(deps, req.user!.userId, id, req.body, 'convert'));
  });
  for (const action of GAME_ACTIONS) {
    router.post(`/:id/${action}`, auth, requireActive, async (req, res) => {
      res.json(await transitionGame(deps, req.user!.userId, gameId(req.params.id), action));
    });
  }
  return router;
}
