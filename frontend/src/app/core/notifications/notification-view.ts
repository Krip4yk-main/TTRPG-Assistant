import {
  NOTIFICATION_TYPES,
  type NotificationCategory,
  type NotificationDto,
  type NotificationType,
} from '@nri/shared';
import { formatDateTime } from '../i18n/dates';

/** Коди причин (а не текст майстра), які бекенд кладе в `params.reason`. */
export const NOTIFICATION_REASON_CODES = ['account_deleted'] as const;

/** Типи з окремим текстом для `reason = account_deleted` (`notifications.<type>_account_deleted`). */
export const ACCOUNT_DELETED_VARIANTS: readonly NotificationType[] = [
  'application.withdrawn',
  'member.left',
  'game.cancelled',
];

/** Жанри з власною подякою після завершення гри (`notifications.thanks.<slug>`). */
export const THANKS_GENRES = [
  'fantasy',
  'dark-fantasy',
  'horror',
  'cyberpunk',
  'scifi',
  'postapoc',
  'steampunk',
  'noir',
  'historical',
  'superhero',
  'comedy',
] as const;

const CATEGORY_ICONS: Record<NotificationCategory, string> = {
  applications: 'assignment',
  members: 'group',
  sessions: 'event',
  reminders: 'alarm',
  games: 'casino',
};

const isType = (t: string): t is NotificationType =>
  (NOTIFICATION_TYPES as readonly string[]).includes(t);
const isReasonCode = (r: string): boolean =>
  (NOTIFICATION_REASON_CODES as readonly string[]).includes(r);

/** Ключ i18n із параметрами. */
export interface Translatable {
  key: string;
  params?: Record<string, string | number>;
}

/**
 * Дані для показу сповіщення: ключ тексту й значення параметрів. `game`/`actor` = `null` —
 * шаблон підставляє перекладені «без назви» / «Хтось» (видалений акаунт або система).
 */
export interface NotificationView {
  key: string;
  game: string | null;
  actor: string | null;
  when: string | null;
  from: string | null;
  /** Ключ фрази «за годину» тощо (лише для нагадувань). */
  offset: Translatable | null;
  /** Додатковий рядок «Причина: …»: перекладений код або текст майстра як є. */
  reason: { code: string | null; text: string | null } | null;
  /** Подяка після завершення гри. */
  thanksKey: string | null;
  icon: string;
}

/** Текст сповіщення з типу й знімка параметрів; дати — у поясі `timeZone` глядача. */
export function notificationView(n: NotificationDto, timeZone: string): NotificationView {
  const p = n.params ?? {};
  const reason = p.reason ?? null;
  const view: NotificationView = {
    key: 'notifications.generic',
    game: p.gameTitle || null,
    actor: p.actor?.nickname || null,
    when: p.startsAt ? formatDateTime(p.startsAt, timeZone) : null,
    from: p.from ? formatDateTime(p.from, timeZone) : null,
    offset: null,
    reason: null,
    thanksKey: null,
    icon: CATEGORY_ICONS[n.category] ?? 'notifications',
  };
  if (!isType(n.type)) return view;

  view.key = `notifications.${n.type}`;
  if (reason && isReasonCode(reason)) {
    if (reason === 'account_deleted' && ACCOUNT_DELETED_VARIANTS.includes(n.type)) {
      view.key = `notifications.${n.type}_${reason}`;
    } else {
      view.reason = { code: reason, text: null };
    }
  } else if (reason && n.type === 'session.cancelled') {
    // Текст майстра (його й так бачать учасники в сесії) — показується як є.
    view.reason = { code: null, text: reason };
  }

  if (n.type === 'session.reminder' && p.offsetMin !== undefined) {
    view.offset = [15, 60, 180, 1440, 2880].includes(p.offsetMin)
      ? { key: `notifications.offset.${p.offsetMin}` }
      : { key: 'notifications.offset.other', params: { n: p.offsetMin } };
  }

  if (n.type === 'game.finished') {
    const slug = p.genreSlug;
    view.thanksKey =
      slug && (THANKS_GENRES as readonly string[]).includes(slug)
        ? `notifications.thanks.${slug}`
        : 'notifications.thanks.default';
  }
  return view;
}

export interface NotificationTime {
  /** Менше хвилини тому. */
  justNow: boolean;
  /** «5 хвилин тому», «вчора»…; `null` — показувати дату. */
  relative: string | null;
  absolute: string;
}

/** Відносний час для недавніх (до тижня) — інакше дата; `now` — момент показу. */
export function notificationTime(iso: string, timeZone: string, now: number): NotificationTime {
  const absolute = formatDateTime(iso, timeZone);
  const diffSec = Math.round((new Date(iso).getTime() - now) / 1000);
  if (Number.isNaN(diffSec)) return { justNow: false, relative: null, absolute };
  const abs = Math.abs(diffSec);
  if (abs < 60) return { justNow: true, relative: null, absolute };
  const rtf = new Intl.RelativeTimeFormat('uk-UA', { numeric: 'auto' });
  if (abs < 3600)
    return { justNow: false, relative: rtf.format(Math.round(diffSec / 60), 'minute'), absolute };
  if (abs < 86_400)
    return { justNow: false, relative: rtf.format(Math.round(diffSec / 3600), 'hour'), absolute };
  if (abs < 7 * 86_400) {
    return { justNow: false, relative: rtf.format(Math.round(diffSec / 86_400), 'day'), absolute };
  }
  return { justNow: false, relative: null, absolute };
}
