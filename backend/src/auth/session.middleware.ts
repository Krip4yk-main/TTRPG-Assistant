import type { Request, RequestHandler } from 'express';
import type { AppDeps } from '../app.js';
import { AppError } from '../http/errors.js';
import {
  clearSessionCookie,
  resolveSessionDetailed,
  revokeAllUserSessions,
  revokeSession,
  SESSION_COOKIE,
  setSessionCookie,
} from './session.service.js';
import type { SessionUser } from './session.service.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
    sessionToken?: string;
  }
}

export function loadSession(deps: AppDeps): RequestHandler {
  return async (req, res, next) => {
    const token = (req.cookies as Record<string, unknown> | undefined)?.[SESSION_COOKIE];
    if (typeof token !== 'string' || !token) {
      next();
      return;
    }
    const resolved = await resolveSessionDetailed(deps, token);
    if (resolved) {
      req.user = resolved.user;
      req.sessionToken = token;
      if (resolved.slidTo) setSessionCookie(res, token, resolved.slidTo, deps.env);
    }
    next();
  };
}

export function requireAuth(deps: AppDeps): RequestHandler {
  return async (req, _res, next) => {
    if (!req.user) throw new AppError(401, 'UNAUTHENTICATED');
    // isBanned береться з кешованого SessionUser; banUser скидає кеш, а прямий SQL
    // (повз banUser) обмежений TTL кешу (≤5 хв).
    if (req.user.isBanned) {
      await revokeAllUserSessions(deps, req.user.userId);
      throw new AppError(403, 'ACCOUNT_BANNED');
    }
    next();
  };
}

export const requireActive: RequestHandler = (req, _res, next) => {
  if (req.user?.status === 'pending') throw new AppError(403, 'PROFILE_INCOMPLETE');
  next();
};

export function logoutHandlers(deps: AppDeps): { logout: RequestHandler; logoutAll: RequestHandler } {
  return {
    logout: async (req: Request, res) => {
      await revokeSession(deps, req.sessionToken!);
      clearSessionCookie(res);
      res.status(204).end();
    },
    logoutAll: async (req: Request, res) => {
      await revokeAllUserSessions(deps, req.user!.userId);
      clearSessionCookie(res);
      res.status(204).end();
    },
  };
}
