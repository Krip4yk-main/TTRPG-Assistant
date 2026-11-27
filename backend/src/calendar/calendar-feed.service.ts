import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, exists, gte, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  CALENDAR_FEED_FUTURE_DAYS,
  CALENDAR_FEED_MAX_EVENTS,
  CALENDAR_FEED_PAST_DAYS,
  type CalendarFeedCreatedDto,
  type CalendarFeedStatusDto,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import { calendarFeeds, gameMembers, gameSessions, games, users } from '../db/schema/index.js';
import { renderIcsCalendar, type IcsEvent } from './ics.js';

const DAY = 86_400_000;
/** 32 випадкові байти → 43 символи base64url. */
const TOKEN_BYTES = 32;
const TOKEN_RE = /^([A-Za-z0-9_-]{43})\.ics$/;
/** `last_access_at` оновлюється не частіше ніж раз на хвилину. */
const ACCESS_TOUCH_MS = 60_000;
/** Точка відліку `SEQUENCE` (секунди `updated_at` від неї — монотонні й поміщаються в int32). */
const SEQUENCE_EPOCH_MS = Date.UTC(2024, 0, 1);
const CALENDAR_NAME = 'НРІ Асистент — мої сесії';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const baseUrl = (deps: Pick<AppDeps, 'env'>) => deps.env.PUBLIC_BASE_URL.replace(/\/+$/, '');

export async function getCalendarFeed(
  deps: Pick<AppDeps, 'db'>,
  userId: number,
): Promise<CalendarFeedStatusDto> {
  const [row] = await deps.db
    .select({ createdAt: calendarFeeds.createdAt })
    .from(calendarFeeds)
    .where(eq(calendarFeeds.userId, userId));
  return { enabled: !!row, createdAt: row ? row.createdAt.toISOString() : null };
}

/** Створює або перевипускає посилання: новий хеш замінює старий одним запитом. */
export async function issueCalendarFeed(
  deps: Pick<AppDeps, 'db' | 'env'>,
  userId: number,
  now = new Date(),
): Promise<CalendarFeedCreatedDto> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const tokenHash = hashToken(token);
  await deps.db
    .insert(calendarFeeds)
    .values({ userId, tokenHash, createdAt: now, lastAccessAt: null })
    .onDuplicateKeyUpdate({ set: { tokenHash, createdAt: now, lastAccessAt: null } });
  return { url: `${baseUrl(deps)}/api/cal/${token}.ics`, createdAt: now.toISOString() };
}

export async function deleteCalendarFeed(deps: Pick<AppDeps, 'db'>, userId: number): Promise<void> {
  await deps.db.delete(calendarFeeds).where(eq(calendarFeeds.userId, userId));
}

function location(g: {
  format: 'online' | 'offline';
  city: string | null;
  platform: string | null;
}) {
  if (g.format === 'online') return g.platform ? `Онлайн · ${g.platform}` : 'Онлайн';
  return g.city ?? 'Офлайн';
}

/**
 * Вміст фіду за ім'ям файлу `<token>.ics`; `null` — посилання невідоме/вимкнене або
 * користувача видалено чи забанено (відповідь — 404 без подробиць). Лише публічні поля гри:
 * назва, формат, місто/платформа; без адреси, учасників, RSVP, нотаток і підсумків.
 */
export async function renderCalendarFeed(
  deps: Pick<AppDeps, 'db' | 'env'>,
  file: string,
  now = new Date(),
): Promise<string | null> {
  const m = TOKEN_RE.exec(file);
  if (!m) return null;
  const { db } = deps;
  const [feed] = await db
    .select({
      userId: calendarFeeds.userId,
      lastAccessAt: calendarFeeds.lastAccessAt,
      status: users.status,
      isBanned: users.isBanned,
    })
    .from(calendarFeeds)
    .innerJoin(users, eq(users.id, calendarFeeds.userId))
    .where(eq(calendarFeeds.tokenHash, hashToken(m[1]!)));
  if (!feed || feed.status !== 'active' || feed.isBanned) return null;
  const userId = feed.userId;

  if (!feed.lastAccessAt || now.getTime() - feed.lastAccessAt.getTime() >= ACCESS_TOUCH_MS) {
    await db
      .update(calendarFeeds)
      .set({ lastAccessAt: now })
      .where(eq(calendarFeeds.userId, userId));
  }

  const rows = await db
    .select({
      id: gameSessions.id,
      startsAt: gameSessions.startsAt,
      durationMinutes: gameSessions.durationMinutes,
      status: gameSessions.status,
      updatedAt: gameSessions.updatedAt,
      gameId: games.id,
      title: games.title,
      format: games.format,
      city: games.city,
      platform: games.platform,
    })
    .from(gameSessions)
    .innerJoin(games, eq(games.id, gameSessions.gameId))
    .where(
      and(
        ne(games.status, 'draft'),
        gte(gameSessions.startsAt, new Date(now.getTime() - CALENDAR_FEED_PAST_DAYS * DAY)),
        lt(gameSessions.startsAt, new Date(now.getTime() + CALENDAR_FEED_FUTURE_DAYS * DAY)),
        or(
          eq(games.gmUserId, userId),
          exists(
            db
              .select({ one: sql`1` })
              .from(gameMembers)
              .where(
                and(
                  eq(gameMembers.gameId, games.id),
                  eq(gameMembers.userId, userId),
                  isNull(gameMembers.leftAt),
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(asc(gameSessions.startsAt), asc(gameSessions.id))
    .limit(CALENDAR_FEED_MAX_EVENTS);

  const base = baseUrl(deps);
  const domain = new URL(base).hostname;
  const events: IcsEvent[] = rows.map((r) => {
    const gameUrl = `${base}/games/${r.gameId}`;
    const cancelled = r.status === 'cancelled';
    return {
      uid: `session-${r.id}@${domain}`,
      start: r.startsAt,
      end: new Date(r.startsAt.getTime() + r.durationMinutes * 60_000),
      sequence: Math.max(0, Math.floor((r.updatedAt.getTime() - SEQUENCE_EPOCH_MS) / 1000)),
      lastModified: r.updatedAt,
      summary: r.title,
      status: cancelled ? 'CANCELLED' : 'CONFIRMED',
      url: gameUrl,
      description: `${cancelled ? 'Сесію скасовано.\n' : ''}Сторінка гри: ${gameUrl}`,
      location: location(r),
    };
  });
  return renderIcsCalendar(CALENDAR_NAME, events, now);
}
