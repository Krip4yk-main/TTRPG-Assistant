import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  PAUSE_REASONS,
  POLL_CLOSE_REASONS,
  POLL_KINDS,
  type NotificationPollOption,
  type PollCloseReason,
  type PollKind,
  type EventType,
  type PauseReason,
  type NotificationActor,
  type NotificationCategory,
  type NotificationParams,
  type NotificationType,
} from '@nri/shared';
import type { Tx } from '../applications/applications.rules.js';
import type { Db } from '../db/client.js';
import { events, gameMembers, games, gameSessions, genres, users } from '../db/schema/index.js';
import { planRatingNotifications } from '../ratings/ratings.notify.js';

export type EventRow = typeof events.$inferSelect;

/** Сповіщення до вставки (див. `insertNotifications`). */
export interface NewNotification {
  /** Подія-джерело; `null` — не з події (нагадування). */
  eventId: number | null;
  userId: number;
  type: NotificationType;
  category: NotificationCategory;
  params: NotificationParams;
  entityType: string | null;
  entityId: number | null;
}

/**
 * Кому адресована подія:
 * - `gm` — майстер гри;
 * - `applicant` — автор заявки (`payload.applicantId`);
 * - `member` — учасник, над яким дія (`payload.memberId`);
 * - `participants` — майстер і активні учасники гри на момент обробки.
 */
type Target = 'gm' | 'applicant' | 'member' | 'participants';

interface Rule {
  category: NotificationCategory;
  to: Target;
  /**
   * Чи `events.user_id` — автор дії (йому сповіщення не шлемо). Для автоскасувань заявок
   * `user_id` — заявник, а дію виконала система.
   */
  actorIsEventUser: boolean;
}

/**
 * Які події сповіщають. Решта (акаунт, профіль, чорний список майстра, апеляції,
 * `game.created/updated/published`, `session.done`) — без отримувачів (`session.done`,
 * `game.finished` і виходи учасників додатково запрошують оцінити — `ratings.notify.ts`).
 */
export const NOTIFY_RULES: Partial<Record<EventType, Rule>> = {
  'application.created': { category: 'applications', to: 'gm', actorIsEventUser: true },
  'application.withdrawn': { category: 'applications', to: 'gm', actorIsEventUser: true },
  'application.approved': { category: 'applications', to: 'applicant', actorIsEventUser: true },
  'application.rejected': { category: 'applications', to: 'applicant', actorIsEventUser: true },
  'application.cancelled_age': {
    category: 'applications',
    to: 'applicant',
    actorIsEventUser: false,
  },
  'application.cancelled_game': {
    category: 'applications',
    to: 'applicant',
    actorIsEventUser: false,
  },
  'member.left': { category: 'members', to: 'gm', actorIsEventUser: true },
  'member.kicked': { category: 'members', to: 'member', actorIsEventUser: true },
  'member.banned': { category: 'members', to: 'member', actorIsEventUser: true },
  'session.rescheduled': { category: 'sessions', to: 'participants', actorIsEventUser: true },
  'session.cancelled': { category: 'sessions', to: 'participants', actorIsEventUser: true },
  // Додаткова разова сесія (застосування голосування за час).
  'session.created': { category: 'sessions', to: 'participants', actorIsEventUser: true },
  'game.started': { category: 'games', to: 'participants', actorIsEventUser: true },
  'game.finished': { category: 'games', to: 'participants', actorIsEventUser: true },
  'game.cancelled': { category: 'games', to: 'participants', actorIsEventUser: true },
  'game.converted_to_campaign': {
    category: 'games',
    to: 'participants',
    actorIsEventUser: true,
  },
  'game.rule_changed': { category: 'games', to: 'participants', actorIsEventUser: true },
  // Пауза й відновлення кампейну: активним учасникам (майстер — автор дії, собі не шле).
  'game.paused': { category: 'games', to: 'participants', actorIsEventUser: true },
  'game.resumed': { category: 'games', to: 'participants', actorIsEventUser: true },
  // Голосування за час (категорія «Розклад», вимикається й на сайті): нове — учасникам (майстер —
  // автор); закрилось само (усі проголосували / дедлайн, `user_id` NULL) — майстру. Закриття
  // майстром (`user_id` = майстер) його ж не сповіщає.
  'poll.created': { category: 'schedule', to: 'participants', actorIsEventUser: true },
  'poll.closed': { category: 'schedule', to: 'gm', actorIsEventUser: true },
};

type Payload = Record<string, unknown>;
const asPayload = (p: unknown): Payload =>
  p && typeof p === 'object' && !Array.isArray(p) ? (p as Payload) : {};
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function ruleFor(ev: EventRow): Rule | null {
  const rule = NOTIFY_RULES[ev.type as EventType];
  if (!rule) return null;
  const p = asPayload(ev.payload);
  // Автоскасування сесій разом із грою (завершення, скасування, нове правило) не сповіщають
  // окремо: учасники вже отримують сповіщення про саму гру — інакше по одному на кожну сесію.
  if (ev.type === 'session.cancelled' && p.auto === true) return null;
  // Відкликання одразу після подання (див. `withdrawApplication`) майстра не турбує.
  if (ev.type === 'application.withdrawn' && p.quick === true) return null;
  // Голосування закрилось разом із грою (завершення/скасування) — майстру підсумок не потрібен.
  if (ev.type === 'poll.closed' && p.reason === 'game_closed') return null;
  // Бан того, хто не був ні учасником, ні автором заявки, нічого в нього не забрав —
  // без сповіщення (інакше майстер міг би слати сповіщення будь-кому).
  if (
    ev.type === 'member.banned' &&
    p.wasMember !== true &&
    !(Array.isArray(p.cancelledApplicationIds) && p.cancelledApplicationIds.length > 0)
  ) {
    return null;
  }
  return rule;
}

function gameIdOf(ev: EventRow): number | undefined {
  if (ev.entityType === 'game') return num(ev.entityId);
  return num(asPayload(ev.payload).gameId);
}

type DbLike = Db | Tx;

/**
 * Перетворює пачку подій на сповіщення: сповіщення самих подій (`NOTIFY_RULES`) і запрошення
 * оцінити (`planRatingNotifications`, категорія `ratings`).
 */
export async function planNotifications(db: DbLike, batch: EventRow[]): Promise<NewNotification[]> {
  return [
    ...(await planEventNotifications(db, batch)),
    ...(await planRatingNotifications(db, batch)),
  ];
}

/**
 * Сповіщення подій за `NOTIFY_RULES`. Читає поточний стан (майстер, склад, назва гри,
 * час сесії, нік автора) — знімок на момент обробки. Отримувачі — лише активні акаунти;
 * автор дії себе не сповіщає.
 */
async function planEventNotifications(db: DbLike, batch: EventRow[]): Promise<NewNotification[]> {
  const todo = batch.flatMap((ev) => {
    const rule = ruleFor(ev);
    const gameId = gameIdOf(ev);
    return rule && gameId !== undefined ? [{ ev, rule, gameId }] : [];
  });
  if (todo.length === 0) return [];

  const gameIds = [...new Set(todo.map((t) => t.gameId))];
  const gameRows = await db
    .select({
      id: games.id,
      title: games.title,
      gmUserId: games.gmUserId,
      genreSlug: genres.slug,
    })
    .from(games)
    .leftJoin(genres, eq(genres.id, games.genreId))
    .where(inArray(games.id, gameIds));
  const gameById = new Map(gameRows.map((g) => [g.id, g]));

  const participantGames = [
    ...new Set(todo.filter((t) => t.rule.to === 'participants').map((t) => t.gameId)),
  ];
  const membersByGame = new Map<number, number[]>();
  if (participantGames.length) {
    const rows = await db
      .select({ gameId: gameMembers.gameId, userId: gameMembers.userId })
      .from(gameMembers)
      .where(and(inArray(gameMembers.gameId, participantGames), isNull(gameMembers.leftAt)));
    for (const r of rows) {
      const list = membersByGame.get(r.gameId) ?? [];
      list.push(r.userId);
      membersByGame.set(r.gameId, list);
    }
  }

  const sessionIds = [
    ...new Set(todo.filter((t) => t.ev.entityType === 'session').map((t) => num(t.ev.entityId)!)),
  ].filter(Boolean);
  const sessionStarts = new Map<number, Date>();
  if (sessionIds.length) {
    const rows = await db
      .select({ id: gameSessions.id, startsAt: gameSessions.startsAt })
      .from(gameSessions)
      .where(inArray(gameSessions.id, sessionIds));
    for (const r of rows) sessionStarts.set(r.id, r.startsAt);
  }

  // Отримувачі кожної події (до фільтра активності).
  const planned = todo.flatMap(({ ev, rule, gameId }) => {
    const game = gameById.get(gameId);
    if (!game) return [];
    const p = asPayload(ev.payload);
    const actorId = rule.actorIsEventUser ? (ev.userId ?? null) : null;
    let to: number[];
    switch (rule.to) {
      case 'gm':
        to = [game.gmUserId];
        break;
      case 'applicant':
        to = [num(p.applicantId) ?? num(ev.userId)].filter((x): x is number => x !== undefined);
        break;
      case 'member':
        to = [num(p.memberId)].filter((x): x is number => x !== undefined);
        break;
      case 'participants':
        to = [game.gmUserId, ...(membersByGame.get(gameId) ?? [])];
        break;
    }
    // Гру закрила адміністрація: майстер отримує окреме `game.closed_by_admin`, не `game.*`.
    const skipGm = p.closedByAdmin === true;
    const recipients = [...new Set(to)].filter(
      (u) => u !== actorId && !(skipGm && u === game.gmUserId),
    );
    return recipients.length ? [{ ev, rule, game, p, actorId, recipients }] : [];
  });
  if (planned.length === 0) return [];

  const userIds = new Set<number>();
  for (const x of planned) {
    for (const u of x.recipients) userIds.add(u);
    if (x.actorId !== null) userIds.add(x.actorId);
  }
  const userRows = await db
    .select({
      id: users.id,
      status: users.status,
      publicId: users.publicId,
      nickname: users.nickname,
    })
    .from(users)
    .where(inArray(users.id, [...userIds]));
  const userById = new Map(userRows.map((u) => [u.id, u]));
  const actorOf = (id: number | null): NotificationActor | null => {
    const u = id === null ? undefined : userById.get(id);
    // Видалений акаунт показується анонімно.
    return u && u.status !== 'deleted' ? { publicId: u.publicId, nickname: u.nickname } : null;
  };

  return planned.flatMap(({ ev, rule, game, p, actorId, recipients }) => {
    const params = paramsFor(ev, game, p, sessionStarts);
    params.actor = actorOf(actorId);
    return recipients
      .filter((u) => userById.get(u)?.status === 'active')
      .map((userId): NewNotification => ({
        eventId: ev.id,
        userId,
        type: ev.type as NotificationType,
        category: rule.category,
        params,
        entityType: ev.entityType,
        entityId: ev.entityId,
      }));
  });
}

function paramsFor(
  ev: EventRow,
  game: { id: number; title: string; genreSlug: string | null },
  p: Payload,
  sessionStarts: Map<number, Date>,
): NotificationParams {
  const params: NotificationParams = { gameId: game.id, gameTitle: game.title };
  if (ev.entityType === 'application' && num(ev.entityId)) params.applicationId = ev.entityId!;
  if (ev.entityType === 'session' && num(ev.entityId)) {
    params.sessionId = ev.entityId!;
    const startsAt = sessionStarts.get(ev.entityId!);
    if (startsAt) params.startsAt = startsAt.toISOString();
  }
  switch (ev.type) {
    case 'session.rescheduled': {
      // Знімок перенесення з події (сесію могли перенести ще раз — то окрема подія).
      const from = str(p.from);
      const to = str(p.to);
      if (from) params.from = from;
      if (to) params.startsAt = to;
      break;
    }
    case 'session.cancelled':
      // Причину скасування сесії бачать усі учасники (SessionDto.cancelReason).
      params.reason = str(p.reason) ?? null;
      break;
    case 'game.cancelled':
    case 'member.left':
    case 'application.withdrawn':
      // Код причини (`account_deleted`) або null — не вільний текст. Бан адміністрацією іншим не
      // розкривається: звичайне сповіщення без причини.
      params.reason = str(p.reason) === 'banned_by_admin' ? null : (str(p.reason) ?? null);
      break;
    case 'game.paused': {
      // Причину й пояснення паузи бачать учасники (GameDto.pauseReason / pauseNote).
      const reason = str(p.reason);
      if (reason && (PAUSE_REASONS as readonly string[]).includes(reason)) {
        params.pauseReason = reason as PauseReason;
      }
      params.note = str(p.note) || null;
      break;
    }
    case 'game.resumed': {
      // Дата першої сесії після паузи й чи оголошено донабір — знімок з події.
      const startsAt = str(p.startsAt);
      if (startsAt) params.startsAt = startsAt;
      params.recruit = p.recruit === true;
      break;
    }
    case 'poll.created':
    case 'poll.closed': {
      // Знімок голосування з події: вид, дедлайн, варіанти (для Telegram-кнопок), підсумок.
      params.pollId = num(ev.entityId) ?? num(p.pollId);
      const kind = str(p.kind);
      if (kind && (POLL_KINDS as readonly string[]).includes(kind)) {
        params.pollKind = kind as PollKind;
      }
      const closesAt = str(p.closesAt);
      if (closesAt) params.closesAt = closesAt;
      if (Array.isArray(p.options)) {
        params.pollOptions = p.options.flatMap((o): NotificationPollOption[] => {
          const x = asPayload(o);
          const id = num(x.id);
          const n = num(x.n);
          const startsAt = str(x.startsAt);
          return id !== undefined && n !== undefined && startsAt ? [{ id, n, startsAt }] : [];
        });
      }
      const reason = str(p.reason);
      if (reason && (POLL_CLOSE_REASONS as readonly string[]).includes(reason)) {
        params.closeReason = reason as PollCloseReason;
      }
      const winner = str(p.winnerStartsAt);
      if (winner) params.startsAt = winner;
      break;
    }
    case 'game.finished':
      // Подяка після гри — текст за жанром (`thanks.<genreSlug>`).
      params.genreSlug = game.genreSlug;
      break;
  }
  return params;
}
