import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { z } from 'zod';
import type { Env } from './config/env.js';
import type { Db } from './db/client.js';
import type { Redis } from './redis/client.js';
import { AppError, errorHandler, notFoundHandler } from './http/errors.js';
import type { OAuthProvider } from './auth/providers/oauth.js';
import { authRouter } from './auth/auth.routes.js';
import { appealsRouter } from './appeals/appeals.routes.js';
import { loadSession, requireActive, requireAuth } from './auth/session.middleware.js';
import { internalRouter } from './internal/internal.routes.js';
import { usersRouter } from './users/users.routes.js';
import { catalogRouter } from './catalog/catalog.routes.js';
import { adminCatalogRouter } from './catalog/catalog.admin.routes.js';
import { profileRouter, publicUsersRouter } from './profiles/profiles.routes.js';
import { availabilityRouter } from './availability/availability.routes.js';
import { calendarRouter } from './calendar/calendar.routes.js';
import { calendarFeedPublicRouter, calendarFeedRouter } from './calendar/calendar-feed.routes.js';
import { gamesRouter } from './games/games.routes.js';
import {
  applicationsRouter,
  gameApplicationsRouter,
  myApplicationsRouter,
} from './applications/applications.routes.js';
import { gameMembersRouter } from './members/members.routes.js';
import { blacklistRouter } from './members/blacklist.routes.js';
import { gameSessionsRouter, sessionsRouter } from './sessions/sessions.routes.js';
import { gameSchedulingRouter, pollsRouter } from './scheduling/scheduling.routes.js';
import { calendarImportRouter } from './scheduling/ical/calendar-import.routes.js';
import type { IcsFetcher } from './scheduling/ical/fetch.js';
import type { IcsParser } from './scheduling/ical/parse-runner.js';
import type { ImageUrlChecker } from './http/image-url.js';
import { gameNotesRouter, sessionNotesRouter } from './notes/notes.routes.js';
import { notificationsRouter } from './notifications/notifications.routes.js';
import { notificationPrefsRouter } from './notifications/prefs.routes.js';
import { ogRouter, seoRootRouter } from './seo/seo.routes.js';
import { viewsRouter } from './views/views.routes.js';
import { gameRatingsRouter, myRatingsRouter } from './ratings/ratings.routes.js';
import { adminComplaintsRouter, complaintsRouter } from './moderation/complaints.routes.js';
import { adminSanctionsRouter, mySanctionsRouter } from './moderation/sanctions.routes.js';
import { adminRouter, mySanctionAppealsRouter } from './moderation/admin.routes.js';
import { adminLogRouter } from './moderation/log.routes.js';
import {
  adminDeadGamesRouter,
  deadGamesRouter,
  myDeadGamesRouter,
} from './games/dead-games/dead-games.routes.js';
import type { RealtimeHub } from './realtime/socket.js';
import { healthRouter } from './http/health.js';
import { csrfProtection, rateLimiters } from './http/security.js';

export type AppDeps = {
  env: Env;
  db: Db;
  redis: Redis;
  /** DI для тестів; за відсутності будуються з env. */
  oauthProviders?: Record<string, OAuthProvider>;
  /** Realtime-хаб; відсутній у тестах без сокетів. */
  realtime?: RealtimeHub;
  /** DI для тестів імпорту iCal: завантаження й розбір (за замовчуванням — безпечні реальні). */
  icsFetcher?: IcsFetcher;
  icsParser?: IcsParser;
  /** DI для тестів: перевірка посилань на картинки (за замовчуванням — безпечна реальна). */
  imageUrlChecker?: ImageUrlChecker;
};

export function createApp(deps: AppDeps): express.Express {
  const { env, redis } = deps;
  const app = express();
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');

  const limits = rateLimiters(env, redis);

  app.use(helmet());
  // Тестовий сервер не індексується: заголовок на всіх відповідях (robots.txt — у seo.routes).
  if (env.DEPLOY_ENV === 'dev') {
    app.use((_req, res, next) => {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      next();
    });
  }
  app.use(cookieParser());
  // Health-check — до rate limiter, CSRF та сесії: без cookie, дешево, не залежить від них.
  app.use(healthRouter(deps));
  // Поза /api: без сесії, CSRF-cookie та загального rate limiter (лише GET — тіло не потрібне).
  app.use(seoRootRouter(deps));
  // Публічний ICS-фід: без cookie/CSRF/сесії (секрет — у посиланні), під власними лімітами.
  app.use(calendarFeedPublicRouter(deps, { ip: limits.calFeedIp, token: limits.calFeedToken }));
  // Rate limiter — ДО парсерів тіла: клієнт поза лімітом не змусить розбирати 1 МБ.
  app.use(['/api/auth', '/api/appeals'], limits.auth);
  app.use('/api', limits.general);
  // Нотатки до 200 000 символів (кирилиця ≈ 400 КБ): окремий ліміт, змонтований ДО глобального
  // (body-parser пропускає вже розібране тіло).
  app.use(['/api/games/:id/notes', '/api/sessions/:id/notes'], express.json({ limit: '1mb' }));
  app.use(express.json({ limit: '100kb' }));
  app.use(csrfProtection(env));
  app.use(loadSession(deps));
  // Кожна перевірка обкладинки — зовнішній запит: ≤ 20 на годину на користувача.
  app.post('/api/games', limits.imageCheck);
  app.patch('/api/games/:id', limits.imageCheck);
  app.put('/api/me/avatar', limits.imageCheck);

  const auth = requireAuth(deps);
  app.use('/api/auth', authRouter(deps));
  app.use('/api/appeals', appealsRouter(deps));
  app.use('/api/me/profile', profileRouter(deps));
  app.use('/api/me/availability', availabilityRouter(deps));
  app.use('/api/me/applications', myApplicationsRouter(deps));
  app.use('/api/me/blacklist', blacklistRouter(deps));
  app.use('/api/me/notifications', notificationsRouter(deps));
  app.use('/api/me/notification-prefs', notificationPrefsRouter(deps));
  app.use('/api/me/views', viewsRouter(deps));
  app.use('/api/me/ratings', myRatingsRouter(deps));
  app.use('/api/me/sanctions', mySanctionsRouter(deps));
  app.use('/api/me/sanctions', mySanctionAppealsRouter(deps));
  app.use('/api/me/dead-games', myDeadGamesRouter(deps));
  app.use('/api/me/calendar-import', calendarImportRouter(deps));
  app.use('/api/me/calendar-feed', calendarFeedRouter(deps));
  app.use('/api/me', calendarRouter(deps));
  app.use('/api/me', usersRouter(deps));
  app.use('/api/users', publicUsersRouter(deps));
  app.use('/api/catalog', catalogRouter(deps));
  app.use('/api/games/:id/applications', gameApplicationsRouter(deps));
  app.use('/api/games/:id/notes', gameNotesRouter(deps));
  app.use('/api/sessions/:id/notes', sessionNotesRouter(deps));
  app.use('/api/games/:id/ratings', gameRatingsRouter(deps));
  app.use('/api/games/:id', gameMembersRouter(deps));
  app.use('/api/games/:id', gameSessionsRouter(deps));
  app.use('/api/games/:id', gameSchedulingRouter(deps));
  app.use('/api/games', deadGamesRouter(deps));
  app.use('/api/games', gamesRouter(deps));
  app.use('/api/applications', applicationsRouter(deps));
  app.use('/api/sessions', sessionsRouter(deps));
  app.use('/api/polls', pollsRouter(deps));
  app.use('/api/complaints', complaintsRouter(deps));
  app.use('/api/admin/complaints', adminComplaintsRouter(deps));
  app.use('/api/admin/log', adminLogRouter(deps));
  app.use('/api/admin/dead-games', adminDeadGamesRouter(deps));
  app.use('/api/admin/catalog', adminCatalogRouter(deps));
  app.use('/api/admin', adminSanctionsRouter(deps));
  app.use('/api/admin', adminRouter(deps));
  app.use('/api/og', ogRouter(deps));
  app.use('/api/internal', internalRouter(deps));

  // Тестові маршрути — лише в NODE_ENV=test.
  if (env.NODE_ENV === 'test') {
    app.post('/api/health-echo', (req, res) => {
      res.json({ ok: true, body: req.body as unknown });
    });
    app.get('/api/auth/ping', (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/api/test/protected', auth, (req, res) => {
      res.json({ ok: true, userId: req.user!.userId });
    });
    app.get('/api/test/active', auth, requireActive, (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/api/boom/app-error', () => {
      throw new AppError(409, 'NICKNAME_TAKEN');
    });
    app.get('/api/boom/async', async () => {
      await Promise.resolve();
      throw new AppError(409, 'NICKNAME_TAKEN');
    });
    app.get('/api/boom/zod', () => {
      z.object({ a: z.string() }).parse({});
    });
    app.get('/api/boom/unknown', () => {
      throw new Error('secret internals');
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
