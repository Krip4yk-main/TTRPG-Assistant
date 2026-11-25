import { Router } from 'express';
import { z } from 'zod';
import type { TelegramOutboxClaimResult } from '@nri/shared';
import type { AppDeps } from '../app.js';
import { claimOutbox, markOutboxFailed, markOutboxSent } from '../notifications/telegram-outbox.js';

const idParam = z.coerce.number().int().positive();

/**
 * Telegram-черга для бота. Монтується всередині `internalRouter` (уже за `requireInternalKey`).
 * Видача — POST, бо змінює рядки (ставить лок).
 */
export function telegramOutboxRouter(deps: AppDeps): Router {
  const router = Router();

  router.post('/claim', async (req, res) => {
    const items = await claimOutbox(deps, req.body);
    res.json({ items } satisfies TelegramOutboxClaimResult);
  });

  router.post('/:id/sent', async (req, res) => {
    await markOutboxSent(deps, idParam.parse(req.params.id));
    res.status(204).end();
  });

  router.post('/:id/failed', async (req, res) => {
    await markOutboxFailed(deps, idParam.parse(req.params.id), req.body);
    res.status(204).end();
  });

  return router;
}
