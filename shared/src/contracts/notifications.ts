import { z } from 'zod';

/** Категорії сповіщень; Telegram вмикається/вимикається для кожної окремо. */
export const NOTIFICATION_CATEGORIES = [
  'applications',
  'members',
  'sessions',
  'reminders',
  'games',
  'ratings',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * Типи сповіщень (`notifications.type`): доменні події, що когось сповіщають,
 * `session.reminder` (нагадування перед сесією, не з подій) і запрошення/нагадування оцінити
 * (`rating.*`: з подій завершення сесії/гри та виходу; `rating.deadline` — за 2 дні до кінця
 * вікна, не з подій). Текст — `notifications.<type>`.
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
  'session.reminder',
  'game.started',
  'game.finished',
  'game.cancelled',
  'game.converted_to_campaign',
  'game.rule_changed',
  'rating.session_open',
  'rating.final_open',
  'rating.member_left',
  'rating.deadline',
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
  actor?: NotificationActor | null;
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

/** Тіло `PUT /api/me/notification-prefs` — повна заміна налаштувань. */
export const notificationPrefsInputSchema = z
  .object({
    telegram: z.object(telegramPrefsShape).strict(),
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
  /** За спаданням (раніше нагадування — першим). */
  reminderOffsets: ReminderOffset[];
}

export const defaultNotificationPrefs = (): NotificationPrefsDto => ({
  telegram: Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, true])) as Record<
    NotificationCategory,
    boolean
  >,
  reminderOffsets: [...DEFAULT_REMINDER_OFFSETS],
});

/** Подія сокета: нове сповіщення (лише id — дані беруться через API). */
export const NOTIFICATION_NEW_EVENT = 'notification.new';

/** Маршрут фронтенду для сповіщення (без домену). */
export function notificationLink(type: NotificationType, p: NotificationParams): string {
  if (p.gameId === undefined) return '/';
  switch (type) {
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
