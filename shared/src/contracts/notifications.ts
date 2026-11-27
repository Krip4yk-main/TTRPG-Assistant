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
 * (майстру, коли закрилось само: `closeReason`, `startsAt` переможця або без нього). Розумне
 * перенесення (не з подій, `schedule`): `session.rsvp_declined` — майстру, що учасник(и)
 * поставили «не буду» на сесію (`sessionId`, `startsAt`, `actor` — перший, `absentees` — усі,
 * `count` — скільки ще крім першого; із затримкою й збиранням кількох в одне). Нагадування
 * про порожній календар (не з подій, `schedule`): `calendar.empty` — учаснику кампейну без
 * тижневих слотів, один раз (`gameId`/`gameTitle` — кампейн, з якого почалось). Імпорт iCal
 * (не з подій, `schedule`): `calendar.import_broken` — власнику посилання, один раз, коли
 * автооновлення зупинилось після кількох невдач поспіль (без параметрів). Строк заявок (не з
 * подій, `applications`, джоб `applications.housekeeping`): `application.pending_reminder` —
 * майстру, один раз, коли заявка 3 дні без рішення (`applicationId`, `actor` — заявник);
 * `application.expired` — заявнику, коли заявку 14 днів не розглянули. Підсумок сесії (не з
 * подій, `schedule`): `session.summary` — учасникам гри на час сесії, один раз (`sessionId`,
 * `startsAt`, `excerpt` — початок підсумку). Приблизний час (не з подій, `sessions`):
 * `session.time_unpinned` — майстру за 24 год до початку вікна, один раз на час сесії:
 * уточни точний час (`sessionId`, `startsAt`, `startWindowMinutes`). X-Card (не з подій,
 * `sessions`): `session.x_card` — майстру, коли хтось із гравців підняв X-Card (`sessionId`,
 * `startsAt`, назва гри); анонімно — без `actor` і без жодних даних про того, хто натиснув;
 * термінове: тихі години не затримують і звук не вимикають. Відгуки про сайт (не з
 * подій, `moderation`; на dev — звіти тестерів, на prod — відгуки користувачів): `tester.report` — власнику платформи на кожен новий звіт
 * (без параметрів); лише на сайті (`SITE_ONLY_TYPES`). Текст — `notifications.<type>`.
 */
export const NOTIFICATION_TYPES = [
  'application.created',
  'application.withdrawn',
  'application.approved',
  'application.rejected',
  'application.cancelled_age',
  'application.cancelled_game',
  'application.pending_reminder',
  'application.expired',
  'member.left',
  'member.kicked',
  'member.banned',
  'session.rescheduled',
  'session.cancelled',
  'session.created',
  'session.reminder',
  'session.summary',
  'session.time_unpinned',
  'session.x_card',
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
  'session.rsvp_declined',
  'calendar.empty',
  'calendar.import_broken',
  'tester.report',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Типи лише для сайту: у Telegram не ставляться (службові сповіщення тестового сервера). */
export const SITE_ONLY_TYPES: readonly NotificationType[] = ['tester.report'];

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
  /**
   * Вікно початку сесії, хв (`startsAt` … `startsAt` + стільки): приблизний час; немає чи
   * `null` — точний час. Для перенесення — нове вікно.
   */
  startWindowMinutes?: number | null;
  /** Вікно початку до перенесення (`from` … `from` + стільки); немає чи `null` — точний час. */
  fromWindowMinutes?: number | null;
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
  /**
   * `calendar.empty`: у користувача підключено імпорт iCal, але немає тижневих слотів —
   * текст пропонує додати звичні години гри (імпорт знає лише зайнятість).
   */
  hasImport?: boolean;
  /** Голосування за час (`poll.*`). */
  pollId?: number;
  pollKind?: PollKind;
  /** Варіанти голосування (`poll.created`) — для тексту в Telegram. */
  pollOptions?: NotificationPollOption[];
  /** Хто з учасників не зможе прийти (`session.rsvp_declined`), у порядку відповіді. */
  absentees?: NotificationActor[];
  /** Початок підсумку сесії з «…», якщо обрізано (`session.summary`). */
  excerpt?: string;
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

/** Час тихих годин — `HH:mm` з кроком 30 хв: 00:00, 00:30 … 23:30. */
export const QUIET_HOURS_TIMES: readonly string[] = Array.from(
  { length: 48 },
  (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
);

/**
 * Тихі години Telegram у поясі користувача (`users.timezone`): повідомлення, поставлене в цей
 * час, надходить у кінці інтервалу; термінові (сесія ≤ 2 год) — одразу, але без звуку.
 * `start > end` — інтервал через північ (23:00–08:00). Сповіщень на сайті не стосується.
 */
export const quietHoursSchema = z
  .object({
    enabled: z.boolean(),
    start: z.string().refine((t) => QUIET_HOURS_TIMES.includes(t)),
    end: z.string().refine((t) => QUIET_HOURS_TIMES.includes(t)),
  })
  .strict()
  .refine((q) => q.start !== q.end, { path: ['end'] });
export type QuietHours = z.infer<typeof quietHoursSchema>;

export const defaultQuietHours = (): QuietHours => ({
  enabled: true,
  start: '23:00',
  end: '08:00',
});

/**
 * Тіло `PUT /api/me/notification-prefs` — повна заміна налаштувань. `site`, `quietHours` (і ключ
 * `schedule` у `telegram`) можна не передавати — тоді лишається збережене значення (сумісність зі
 * старими клієнтами).
 */
export const notificationPrefsInputSchema = z
  .object({
    telegram: z.object({ ...telegramPrefsShape, schedule: z.boolean().optional() }).strict(),
    site: z.object(sitePrefsShape).strict().optional(),
    quietHours: quietHoursSchema.optional(),
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
  /** Тихі години Telegram (див. `quietHoursSchema`). */
  quietHours: QuietHours;
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
  quietHours: defaultQuietHours(),
});

/** Подія сокета: нове сповіщення (лише id — дані беруться через API). */
export const NOTIFICATION_NEW_EVENT = 'notification.new';

/** Маршрут фронтенду для сповіщення (без домену). */
export function notificationLink(type: NotificationType, p: NotificationParams): string {
  // Модерація — без гри: черга скарг персоналу; «скаргу розглянуто» — без подробиць.
  if (type === 'moderation.digest') return '/admin/complaints';
  if (type === 'complaint.resolved') return '/';
  if (type === 'tester.report') return '/admin/tester-reports';
  // Санкції — сторінка «Обмеження акаунта» (фронтенд, Task 5).
  if (type === 'sanction.imposed' || type === 'sanction.lifted' || type === 'appeal.decided') {
    return '/my-sanctions';
  }
  // Позначки детектора «мертвих» ігор — до «Моїх ігор»: там пояснення й дії «Все ок» / «Закрити».
  if (type === 'game.stale_reminder' || type === 'game.dead' || type === 'game.suspicious') {
    return '/my-games';
  }
  // Нагадування про календар — до редактора доступності.
  if (type === 'calendar.empty' || type === 'calendar.import_broken') return '/calendar';
  if (p.gameId === undefined) return '/';
  switch (type) {
    case 'poll.created':
    case 'poll.closed':
      return p.pollId !== undefined ? `/games/${p.gameId}?poll=${p.pollId}` : `/games/${p.gameId}`;
    case 'session.rsvp_declined':
    case 'session.time_unpinned':
    case 'session.x_card':
      return p.sessionId !== undefined
        ? `/games/${p.gameId}?session=${p.sessionId}`
        : `/games/${p.gameId}`;
    case 'rating.session_open':
    case 'rating.final_open':
    case 'rating.member_left':
    case 'rating.deadline':
      return p.sessionId !== undefined
        ? `/games/${p.gameId}/rate?session=${p.sessionId}`
        : `/games/${p.gameId}/rate`;
    case 'application.created':
    case 'application.withdrawn':
    case 'application.pending_reminder':
      return `/games/${p.gameId}/applications`;
    case 'application.rejected':
    case 'application.expired':
    case 'application.cancelled_age':
    case 'application.cancelled_game':
      return '/my-applications';
    default:
      return `/games/${p.gameId}`;
  }
}
