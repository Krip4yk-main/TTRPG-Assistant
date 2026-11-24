import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ErrorCode } from '@nri/shared';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    public readonly details?: unknown,
  ) {
    super(code);
    this.name = 'AppError';
  }
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND'));
};

function body(code: ErrorCode, details?: unknown) {
  return { error: details === undefined ? { code } : { code, details } };
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json(body(err.code, err.details));
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json(body('VALIDATION', err.issues));
    return;
  }
  // Помилки body-parser (некоректний JSON, 413 entity.too.large, 415 тощо) — клієнтські:
  // віддаємо їхній 4xx-статус із кодом VALIDATION, без стеку в лог.
  if (err && typeof err === 'object') {
    const { type, status } = err as { type?: unknown; status?: unknown };
    if (typeof type === 'string' && typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json(body('VALIDATION'));
      return;
    }
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL' } });
};
