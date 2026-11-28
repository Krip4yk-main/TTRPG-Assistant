import { Router } from 'express';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import { games, users } from '../db/schema/index.js';
import { listedGamePredicate } from '../games/games.search.js';
import { getPublicProfileHead } from '../profiles/profiles.service.js';
import { truncateDescription } from './excerpt.js';

const SITE_NAME = 'НРІ Асистент';
const NEUTRAL_TITLE = SITE_NAME;
const SITEMAP_LIMIT = 50_000;
const SITEMAP_KEY = 'seo:sitemap';
const SITEMAP_TTL_SEC = 600;
const CACHE = 'public, max-age=3600';

/** Сторінка для спонсорів (`/sponsors`): статичні OG-метадані, картинка — промо 1920×1080 з ассетів фронтенду. */
export const SPONSORS_PATH = '/sponsors';
export const SPONSORS_OG_IMAGE_PATH = '/assets/promo/nri-promo-1920x1080.png';
const SPONSORS_TITLE = `Спонсорам — ${SITE_NAME}`;
const SPONSORS_DESCRIPTION =
  'НРІ Асистент — безкоштовний український сервіс пошуку настільних рольових ігор для гравців і майстрів. Шукаємо спонсорів: t.me/krip4yk.';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
/** Екранування для HTML-тексту й атрибутів (і для XML). */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

type OgInput = {
  title: string;
  url: string;
  type: 'website' | 'profile';
  description?: string;
  image?: string | null;
  noindex?: boolean;
};

function renderOg(o: OgInput): string {
  const title = escapeHtml(o.title);
  const tags = [
    `<title>${title}</title>`,
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">`,
    `<meta property="og:type" content="${o.type}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:url" content="${escapeHtml(o.url)}">`,
    `<meta name="twitter:card" content="${o.image?.startsWith('https://') ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${title}">`,
  ];
  if (o.description) {
    const d = escapeHtml(o.description);
    tags.push(
      `<meta name="description" content="${d}">`,
      `<meta property="og:description" content="${d}">`,
      `<meta name="twitter:description" content="${d}">`,
    );
  }
  if (o.image?.startsWith('https://')) {
    const i = escapeHtml(o.image);
    tags.push(
      `<meta property="og:image" content="${i}">`,
      `<meta name="twitter:image" content="${i}">`,
    );
  }
  if (o.noindex) tags.push('<meta name="robots" content="noindex">');
  return `<!doctype html>\n<html lang="uk">\n<head>\n<meta charset="utf-8">\n${tags.join('\n')}\n</head>\n<body></body>\n</html>\n`;
}

function sendHtml(res: import('express').Response, html: string, status = 200): void {
  res.status(status).type('html').send(html);
}

function neutral(url: string): string {
  return renderOg({ title: NEUTRAL_TITLE, url, type: 'website', noindex: true });
}

/**
 * Краулери для навчання ШІ — заборонено (див. AI_POLICY.md); звичайні пошуковики індексують як раніше.
 * Це прохання, яке шанують сумлінні боти; юридично захищає ліцензія (LICENSE).
 */
export const AI_CRAWLERS = [
  'GPTBot',
  'ClaudeBot',
  'anthropic-ai',
  'CCBot',
  'Google-Extended',
  'Applebot-Extended',
  'PerplexityBot',
  'Bytespider',
  'meta-externalagent',
  'cohere-ai',
  'cohere-training-data-crawler',
  'Diffbot',
  'omgili',
  'Timpibot',
  'ImagesiftBot',
] as const;
const AI_CRAWLERS_BLOCK = AI_CRAWLERS.map((ua) => `User-agent: ${ua}\nDisallow: /\n\n`).join('');

/** Маршрути поза `/api`: `/sitemap.xml`, `/robots.txt` (без сесії, CSRF і rate limiter). */
export function seoRootRouter(deps: AppDeps): Router {
  const { db, env } = deps;
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const router = Router();

  router.get('/robots.txt', (_req, res) => {
    if (env.DEPLOY_ENV === 'dev') {
      res.set('Cache-Control', CACHE).type('text/plain').send('User-agent: *\nDisallow: /\n');
      return;
    }
    res
      .set('Cache-Control', CACHE)
      .type('text/plain')
      .send(
        AI_CRAWLERS_BLOCK +
          `User-agent: *\nAllow: /\nDisallow: /account\nDisallow: /api/\n\nSitemap: ${base}/sitemap.xml\n`,
      );
  });

  router.get('/sitemap.xml', async (_req, res) => {
    const cached = await deps.redis.get(SITEMAP_KEY);
    if (cached) {
      res.set('Cache-Control', CACHE).type('application/xml').send(cached);
      return;
    }
    const gameRows = await db
      .select({ id: games.id, updatedAt: games.updatedAt })
      .from(games)
      .where(
        and(
          inArray(games.status, ['recruiting', 'started']),
          eq(games.ageRating, 'none'),
          listedGamePredicate(new Date()),
        ),
      )
      .orderBy(asc(games.id))
      .limit(SITEMAP_LIMIT);
    const userRows = await db
      .select({ publicId: users.publicId, updatedAt: users.updatedAt })
      .from(users)
      .where(and(eq(users.status, 'active'), eq(users.isBanned, false)))
      .orderBy(asc(users.id))
      .limit(SITEMAP_LIMIT);
    const entry = (path: string, updatedAt?: Date) =>
      `<url><loc>${escapeHtml(`${base}${path}`)}</loc>${
        updatedAt ? `<lastmod>${updatedAt.toISOString()}</lastmod>` : ''
      }</url>`;
    const urls = [
      entry(''),
      entry('/about'),
      entry(SPONSORS_PATH),
      ...gameRows.map((g) => entry(`/games/${g.id}`, g.updatedAt)),
      ...userRows.map((u) => entry(`/users/${u.publicId}`, u.updatedAt)),
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
    await deps.redis.set(SITEMAP_KEY, xml, 'EX', SITEMAP_TTL_SEC);
    res.set('Cache-Control', CACHE).type('application/xml').send(xml);
  });

  return router;
}

/** `/api/og/*` — мінімальні HTML-документи для ботів прев'ю посилань. */
export function ogRouter(deps: AppDeps): Router {
  const { db, env } = deps;
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const router = Router();

  router.get('/sponsors', (_req, res) => {
    res.set('Cache-Control', CACHE);
    sendHtml(
      res,
      renderOg({
        title: SPONSORS_TITLE,
        url: `${base}${SPONSORS_PATH}`,
        type: 'website',
        description: SPONSORS_DESCRIPTION,
        image: `${base}${SPONSORS_OG_IMAGE_PATH}`,
        // Тестовий сервер не індексується, як і решта сторінок там.
        noindex: env.DEPLOY_ENV === 'dev',
      }),
    );
  });

  router.get('/games/:id', async (req, res) => {
    const id = /^\d{1,15}$/.test(req.params.id) ? Number(req.params.id) : NaN;
    const [g] = Number.isSafeInteger(id)
      ? await db.select().from(games).where(eq(games.id, id))
      : [];
    if (!g) {
      sendHtml(res, neutral(`${base}/games`), 404);
      return;
    }
    const open =
      (g.status === 'recruiting' || g.status === 'started') &&
      g.ageRating === 'none' &&
      (g.recurrence !== 'none' || (g.startsAt !== null && g.startsAt > new Date()));
    if (!open) {
      sendHtml(res, neutral(`${base}/games/${g.id}`));
      return;
    }
    sendHtml(
      res,
      renderOg({
        title: g.title,
        url: `${base}/games/${g.id}`,
        type: 'website',
        description: truncateDescription(g.description) || undefined,
        image: g.coverUrl,
        // «Мертва» гра: прев'ю посилання лишається, але без індексації.
        noindex: g.deadAt !== null,
      }),
    );
  });

  router.get('/users/:publicId', async (req, res) => {
    const publicId = req.params.publicId;
    const url = `${base}/users/${encodeURIComponent(publicId)}`;
    const profile = await getPublicProfileHead(deps, publicId);
    if (!profile) {
      sendHtml(res, neutral(`${base}/`), 404);
      return;
    }
    if (profile.status === 'deleted' || profile.isBanned) {
      sendHtml(res, neutral(url));
      return;
    }
    sendHtml(
      res,
      renderOg({
        title: profile.nickname ?? 'Профіль',
        url,
        type: 'profile',
        description: profile.bio ? truncateDescription(profile.bio) : undefined,
        image: profile.avatarUrl,
      }),
    );
  });

  return router;
}
