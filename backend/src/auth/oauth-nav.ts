import type { Request } from 'express';

/**
 * `GET /api/auth/:provider/(start|callback)` — це top-level навігація браузера, а не XHR:
 * помилки тут треба віддавати редиректом на сторінку SPA, а не JSON.
 */
const OAUTH_NAV = /^\/api\/auth\/[^/]+\/(start|callback)\/?$/i;

/**
 * Куди редиректити помилку OAuth-навігації: `/account` для `?mode=link` на start,
 * інакше `/login`. `null` — запит не є OAuth-навігацією.
 */
export function oauthNavErrorBase(req: Request): '/login' | '/account' | null {
  if (req.method !== 'GET') return null;
  const path = req.originalUrl.split('?')[0] ?? '';
  const m = OAUTH_NAV.exec(path);
  if (!m) return null;
  return m[1]?.toLowerCase() === 'start' && req.query.mode === 'link' ? '/account' : '/login';
}
