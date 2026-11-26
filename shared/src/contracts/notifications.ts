import { z } from 'zod';
import type { PauseReason } from './games.js';
import type { PollCloseReason, PollKind } from './polls.js';
import type { SanctionType } from './moderation.js';

/** Категорії сповіщень; Telegram вмикається/вимикається для кожної окремо. */
export const NOTIFICATION_CATEGORIES = [
  'applications',
  'members',
  'sessions',
  'reminders',
  'games',
  'ratings',
  'moderation',
  'schedule',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * Категорії, які можна вимкнути й на сайті (не лише в Telegram): «Розклад» — голосування за
 * час, нагадування про календар, пропозиції перенесення (Plan 12). Вимкнена — сповіщення цієї
 * категорії не створюються взагалі (ні на сайті, ні в Telegram).
 */
export const SITE_OPTIONAL_CATEGORIES = ['schedule'] as const;
export type SiteOptionalCategory = (typeof SITE_OPTIONAL_CATEGORIES)[number];

/**
 * Типи сповіщень (`notifications.type`): доменні події, що когось сповіщають,
 * `session.reminder` (нагадування перед сесією, не з подій) і запрошення/нагадування оцінити
 * (`rating.*`: з подій завершення сесії/гри та виходу; `rating.deadline` — за 2 дні до кінця
 * вікна, не з подій). Модерація (не з подій): `complaint.resolved` — скаржнику, без подробиць;
 * `moderation.digest` — персоналу щоденне зведення нових скарг (`count`); `sanction.imposed` /
 * `sanction.lifted` — покараному: тип (`sanctionType`), кінець (`endsAt`), причина (`reason`,
 * лише для накладення — її бачить сам покараний); `appeal.decided` — автору апеляції: тип
 * санкції, `accepted` і примітка (`reason`, необов'язкова). Детектор «мертвих» ігор (не з
 * подій, майстру): `game.stale_reminder` (давно не проводилась), `game.dead` (позначено
 * «мертвою»), `game.suspicious` (накладання сесій), `game.closed_by_admin`. Пауза кампейну:
 * `game.paused` (учасникам: `pauseReason`, `note`), `game.resumed` (учасникам: `startsAt` першої
 * сесії, `recruit` — оголошено донабір), `game.long_pause` (не з подій, майстру: кампейн на паузі
 * понад 90 днів). Голосування за час (категорія `schedule`): `poll.created` (учасникам: `pollId`,
 * `pollKind`, `pollOptions`, дедлайн `closesAt`; у Telegram — кнопки відповіді), `poll.closed`
 * (майстру, коли закрилось само: `closeReason`, `startsAt` переможця або без нього). Текст —
 * `notifications.<type>`.
 */
export const NOTIFICATION_TYPES = [
  'application.created',
  'application.withdrawn',
  'application.approved',
  'application.rejected',
  'application.cancelled_age',
  'application.cancelled_game',
  'member.left',
  'member.kicked',
  'member.banned',
  'session.rescheduled',
  'session.cancelled',
  'session.created',
  'session.reminder',
  'game.started',
  'game.finished',
  'game.cancelled',
  'game.converted_to_campaign',
  'game.rule_changed',
  'game.stale_reminder',
  'game.dead',
  'game.suspicious',
  'game.closed_by_admin',
  'game.paused',
  'game.resumed',
  'game.long_pause',
  'rating.session_open',
  'rating.final_open',
  'rating.member_left',
  'rating.deadline',
  'complaint.resolved',
  'moderation.digest',
  'sanction.imposed',
  'sanction.lifted',
  'appeal.decided',
  'poll.created',
  'poll.closed',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Дозволені офсети нагадувань, хвилини до початку сесії: 15 хв, 1 год, 3 год, 24 год, 48 год. */
export const REMINDER_OFFSETS = [15, 60, 180, 1440, 2880] as const;
export type ReminderOffset = (typeof REMINDER_OFFSETS)[number];
export const DEFAULT_REMINDER_OFFSETS: ReminderOffset[] = [1440, 60];

export const NOTIFICATIONS_PAGE_MAX = 50;
export const NOTIFICATIONS_PAGE_DEFAULT = 20;

/** Хто виконав дію (публічні дані); `null` — система або видалений акаунт. */
export interface NotificationActor {
  publicId: string;
  nickname: string | null;
}

/**
 * Параметри для тексту й посилання — лише те, що отримувач і так може бачити.
 * Набір полів залежить від типу; відсутні поля не передаються.
 */
export interface NotificationParams {
  gameId?: number;
  /** Назва гри на момент створення сповіщення. */
  gameTitle?: string | null;
  applicationId?: number;
  sessionId?: number;
  /** Початок сесії (ISO UTC); для перенесення — новий час; у `rating.deadline` сесійного набору — дата тієї сесії. */
  startsAt?: string;
  /** Старий час перенесеної сесії (ISO UTC). */
  from?: string;
  /** Причина скасування сесії (текст майстра) або код (`account_deleted`). */
  reason?: string | null;
  /** Жанр гри (slug) — для подяки після завершення (`thanks.<genreSlug>`). */
  genreSlug?: string | null;
  /** Офсет нагадування, хвилини. */
  offsetMin?: number;
  /** Коли закривається вікно оцінювання (ISO UTC); немає — без дедлайну. */
  closesAt?: string;
  /** Кого запрошують оцінити (той, хто вийшов з гри). */
  ratee?: NotificationActor;
  /** Кількість нових скарг, видимих отримувачу (`moderation.digest`). */
  count?: number;
  /** Тип санкції (`sanction.imposed` / `sanction.lifted`). */
  sanctionType?: SanctionType;
  /** Рішення по апеляції (`appeal.decided`): прийнято — санкцію знято. */
  accepted?: boolean;
  /** Кінець санкції (ISO UTC); `null` — назавжди (`sanction.imposed`). */
  endsAt?: string | null;
  /** Причина паузи кампейну (`game.paused`). */
  pauseReason?: PauseReason;
  /** Пояснення майстра до паузи (`game.paused`); `null` — без пояснення. */
  note?: string | null;
  /** Відновлення з донабором (`game.resumed`). */
  recruit?: boolean;
  /** Голосування за час (`poll.*`). */
  pollId?: number;
  pollKind?: PollKind;
  /** Варіанти голосування (`poll.created`) — для тексту в Telegram. */
  pollOptions?: NotificationPollOption[];
  /** Чому закрилось голосування (`poll.closed`). */
  closeReason?: PollCloseReason;
  actor?: NotificationActor | null;
}

/**
 * Варіант голосування в сповіщенні: id (для Telegram-кнопок), номер 1…6 і час (ISO UTC; для
 * `regular` — перша сесія).
 */
export interface NotificationPollOption {
  id: number;
  n: number;
  startsAt: string;
}

/** Сповіщення (`GET /api/me/notifications`). */
export interface NotificationDto {
  id: number;
  type: NotificationType;
  category: NotificationCategory;
  params: NotificationParams;
  /** Маршрут фронтенду, куди веде сповіщення. */
  link: string;
  createdAt: string;
  readAt: string | null;
}

/** Сторінка сповіщень: новіші першими; `nextCursor` — для `?cursor=`, `null` — кінець. */
export interface NotificationsPage {
  items: NotificationDto[];
  nextCursor: number | null;
}

/** `GET /api/me/notifications/unread-count`. */
export interface UnreadCountDto {
  count: number;
}

/** Query `GET /api/me/notifications`. */
export const notificationsQuerySchema = z.object({
  // Порожній `cursor=` — як відсутній.
  cursor: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(NOTIFICATIONS_PAGE_MAX)
    .default(NOTIFICATIONS_PAGE_DEFAULT),
});

const telegramPrefsShape = Object.fromEntries(
  NOTIFICATION_CATEGORIES.map((c) => [c, z.boolean()]),
) as Record<NotificationCategory, z.ZodBoolean>;

const sitePrefsShape = Object.fromEntries(
  SITE_OPTIONAL_CATEGORIES.map((c) => [c, z.boolean()]),
) as Record<SiteOptionalCategory, z.ZodBoolean>;

/**
 * Тіло `PUT /api/me/notification-prefs` — повна заміна налаштувань. `site` (і ключ `schedule`
 * у `telegram`) можна не передавати — тоді лишається збережене значення (сумісність зі
 * старими клієнтами).
 */
export const notificationPrefsInputSchema = z
  .object({
    telegram: z.object({ ...telegramPrefsShape, schedule: z.boolean().optional() }).strict(),
    site: z.object(sitePrefsShape).strict().optional(),
    /** Порожній список — нагадування вимкнено; дублікати прибираються. */
    reminderOffsets: z
      .array(z.union(REMINDER_OFFSETS.map((o) => z.literal(o))))
      .max(REMINDER_OFFSETS.length)
      .transform((a) => [...new Set(a)].sort((x, y) => y - x)),
  })
  .strict();
export type NotificationPrefsInput = z.input<typeof notificationPrefsInputSchema>;

/** `GET/PUT /api/me/notification-prefs`. */
export interface NotificationPrefsDto {
  telegram: Record<NotificationCategory, boolean>;
  /** Сповіщення на сайті для категорій, які можна вимкнути (`SITE_OPTIONAL_CATEGORIES`). */
  site: Record<SiteOptionalCategory, boolean>;
  /** За спаданням (раніше нагадування — першим). */
  reminderOffsets: ReminderOffset[];
}

export const defaultNotificationPrefs = (): NotificationPrefsDto => ({
  telegram: Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, true])) as Record<
    NotificationCategory,
    boolean
  >,
  site: Object.fromEntries(SITE_OPTIONAL_CATEGORIES.map((c) => [c, true])) as Record<
    SiteOptionalCategory,
    boolean
  >,
  reminderOffsets: [...DEFAULT_REMINDER_OFFSETS],
});

/** Подія сокета: нове сповіщення (лише id — дані беруться через API). */
export const NOTIFICATION_NEW_EVENT = 'notification.new';

/** Маршрут фронтенду для сповіщення (без домену). */
export function notificationLink(type: NotificationType, p: NotificationParams): string {
  // Модерація — без гри: черга скарг персоналу; «скаргу розглянуто» — без подробиць.
  if (type === 'moderation.digest') return '/admin/complaints';
  if (type === 'complaint.resolved') return '/';
  // Санкції — сторінка «Обмеження акаунта» (фронтенд, Task 5).
  if (type === 'sanction.imposed' || type === 'sanction.lifted' || type === 'appeal.decided') {
    return '/my-sanctions';
  }
  // Позначки детектора «мертвих» ігор — до «Моїх ігор»: там пояснення й дії «Все ок» / «Закрити».
  if (type === 'game.stale_reminder' || type === 'game.dead' || type === 'game.suspicious') {
    return '/my-games';
  }
  if (p.gameId === undefined) return '/';
  switch (type) {
    case 'poll.created':
    case 'poll.closed':
      return p.pollId !== undefined ? `/games/${p.gameId}?poll=${p.pollId}` : `/games/${p.gameId}`;
    case 'rating.session_open':
    case 'rating.final_open':
    case 'rating.member_left':
    case 'rating.deadline':
      return p.sessionId !== undefined
        ? `/games/${p.gameId}/rate?session=${p.sessionId}`
        : `/games/${p.gameId}/rate`;
    case 'application.created':
    case 'application.withdrawn':
      return `/games/${p.gameId}/applications`;
    case 'application.rejected':
    case 'application.cancelled_age':
    case 'application.cancelled_game':
      return '/my-applications';
    default:
      return `/games/${p.gameId}`;
  }
}
