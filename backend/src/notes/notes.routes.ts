import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireActive, requireAuth } from '../auth/session.middleware.js';
import { gameId as numericId } from '../games/games.routes.js';
import {
  getGamePrivateNote,
  getSessionNote,
  getSharedNotes,
  putGamePrivateNote,
  putSessionNote,
  putSharedNote,
} from './notes.service.js';

const idOf = (req: { params: unknown }) => numericId((req.params as { id?: string }).id);

/** Монтується на `/api/games/:id/notes`: спільна й приватна нотатки гри. */
export function gameNotesRouter(deps: AppDeps): Router {
  const router = Router({ mergeParams: true });
  const auth = requireAuth(deps);
  router.get('/shared', auth, requireActive, async (req, res) => {
    res.json(await getSharedNotes(deps, req.user!.userId, idOf(req)));
  });
  router.put('/shared', auth, requireActive, async (req, res) => {
    res.json(await putSharedNote(deps, req.user!.userId, idOf(req), req.body));
  });
  router.get('/private', auth, requireActive, async (req, res) => {
    res.json(await getGamePrivateNote(deps, req.user!.userId, idOf(req)));
  });
  router.put('/private', auth, requireActive, async (req, res) => {
    res.json(await putGamePrivateNote(deps, req.user!.userId, idOf(req), req.body));
  });
  return router;
}

/** Монтується на `/api/sessions/:id/notes`: приватна нотатка сесії. */
export function sessionNotesRouter(deps: AppDeps): Router {
  const router = Router({ mergeParams: true });
  const auth = requireAuth(deps);
  router.get('/private', auth, requireActive, async (req, res) => {
    res.json(await getSessionNote(deps, req.user!.userId, idOf(req)));
  });
  router.put('/private', auth, requireActive, async (req, res) => {
    res.json(await putSessionNote(deps, req.user!.userId, idOf(req), req.body));
  });
  return router;
}
