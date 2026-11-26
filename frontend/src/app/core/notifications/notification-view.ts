import {
  NOTIFICATION_TYPES,
  REMINDER_OFFSETS,
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

/**
 * Типи, у тексті яких є `{{actor}}`: без автора (система чи видалений акаунт) — окремий текст
 * без «від Хтось» (`notifications.<type>_anonymous`).
 */
export const ANONYMOUS_VARIANTS: readonly NotificationType[] = [
  'application.created',
  'application.withdrawn',
  'member.left',
  'session.rsvp_declined',
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
  ratings: 'star',
  moderation: 'shield',
  schedule: 'how_to_vote',
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
  /**
   * Додатковий рядок «Причина: …»: перекладений код (`notifications.reasons.<code>`) або текст
   * майстра як є; обидва — «код — текст» (пауза кампейну: причина зі списку й пояснення).
   */
  reason: { code: string | null; text: string | null } | null;
  /** Подяка після завершення гри. */
  thanksKey: string | null;
  /** Кого запрошують оцінити (`rating.member_left`); `null` — «Хтось». */
  ratee: string | null;
  /** Строк оцінювання (`rating.*` з `closesAt`) — рядок «Оцінити можна до …». */
  closes: string | null;
  /** Кількість нових скарг (`moderation.digest`); інакше 0. */
  count: number;
  /** Ключ назви типу санкції (`sanction.*`, `notifications.sanction.types.<type>`); інакше null. */
  sanction: string | null;
  /** Кінець санкції (`sanction.imposed`); безстрокова — окремий текст `_permanent`. */
  until: string | null;
  /**
   * Швидкі дії під сповіщенням — посилання на сторінку гри з `?action=…` (нагадування про
   * довгу паузу: відновити, оголосити донабір, завершити); інакше порожньо.
   */
  actions: NotificationActionView[];
  icon: string;
}

export interface NotificationActionView {
  labelKey: string;
  /** Значення `?action=` на сторінці гри. */
  action: string;
}

/** Дії нагадування про довгу паузу — ті самі, що на панелі паузи сторінки гри. */
const LONG_PAUSE_ACTIONS: readonly NotificationActionView[] = [
  { labelKey: 'games.actions.resume', action: 'resume' },
  { labelKey: 'games.actions.recruit', action: 'recruit' },
  { labelKey: 'games.pause.panel.finish', action: 'finish' },
];

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
    ratee: p.ratee?.nickname || null,
    closes: null,
    count: p.count ?? 0,
    sanction: null,
    until: null,
    actions: [],
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
  if (
    view.key === `notifications.${n.type}` &&
    !view.actor &&
    ANONYMOUS_VARIANTS.includes(n.type)
  ) {
    view.key = `notifications.${n.type}_anonymous`;
  }

  if (n.type === 'session.reminder' && p.offsetMin !== undefined) {
    view.offset = (REMINDER_OFFSETS as readonly number[]).includes(p.offsetMin)
      ? { key: `notifications.offset.${p.offsetMin}` }
      : { key: 'notifications.offset.other', params: { n: p.offsetMin } };
  }

  // Пауза кампейну: причина зі списку й пояснення майстра (їх бачать учасники гри).
  if (n.type === 'game.paused' && (p.pauseReason || p.note)) {
    view.reason = {
      code: p.pauseReason ? `pause.${p.pauseReason}` : null,
      text: p.note || null,
    };
  }
  // Нагадування про календар тому, хто підключив лише імпорт iCal (як у боті).
  if (n.type === 'calendar.empty' && p.hasImport === true) {
    view.key = 'notifications.calendar.empty_imported';
  }
  // «Не буду» кількох учасників одним сповіщенням — «X та ще N» (як у боті).
  if (n.type === 'session.rsvp_declined' && (p.count ?? 0) > 0) {
    view.key = 'notifications.session.rsvp_declined_many';
  }
  // Розклад: календарні нагадування й «не буду» — власні значки замість загального.
  if (n.type === 'calendar.empty' || n.type === 'calendar.import_broken') {
    view.icon = n.type === 'calendar.empty' ? 'edit_calendar' : 'sync_problem';
  } else if (n.type === 'session.rsvp_declined') {
    view.icon = 'event_busy';
  }
  // Відновлення з донабором — окремий текст (як у боті).
  if (n.type === 'game.resumed' && p.recruit === true) {
    view.key = 'notifications.game.resumed_recruit';
  }

  // Довга пауза: майстру — швидкі дії на сторінці гри.
  if (n.type === 'game.long_pause' && n.link.startsWith('/games/')) {
    view.actions = [...LONG_PAUSE_ACTIONS];
  }

  // Нагадування про дедлайн сесійного набору — з датою сесії (як у боті).
  if (n.type === 'rating.deadline' && p.sessionId !== undefined && p.startsAt) {
    view.key = 'notifications.rating.deadline_session';
  }

  if (n.type.startsWith('rating.') && p.closesAt) {
    view.closes = formatDateTime(p.closesAt, timeZone);
  }

  // Санкції: тип, кінець і причина (її бачить лише сам покараний).
  if (
    n.type === 'sanction.imposed' ||
    n.type === 'sanction.lifted' ||
    n.type === 'appeal.decided'
  ) {
    view.sanction = `notifications.sanction.types.${p.sanctionType ?? 'unknown'}`;
  }
  if (n.type === 'sanction.imposed') {
    if (p.endsAt) view.until = formatDateTime(p.endsAt, timeZone);
    else view.key = 'notifications.sanction.imposed_permanent';
    if (reason) view.reason = { code: null, text: reason };
  }

  // Рішення по апеляції: прийнято/відхилено й примітка персоналу (адресована автору апеляції).
  if (n.type === 'appeal.decided') {
    if (p.accepted !== undefined) {
      view.key = `notifications.appeal.${p.accepted ? 'decided_accepted' : 'decided_rejected'}`;
    }
    if (reason) view.reason = { code: null, text: reason };
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
