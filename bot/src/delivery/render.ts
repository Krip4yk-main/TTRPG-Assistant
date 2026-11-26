import {
  NOTIFICATION_TYPES,
  notificationLink,
  type NotificationParams,
  type NotificationType,
  type TelegramButton,
} from '@nri/shared';
import uk from '../i18n/uk.json' with { type: 'json' };
import { lookup, makeT, type Translate } from '../i18n/t.js';
import { encodeCallback } from './callback-data.js';

/** Ліміт Telegram на текст повідомлення, символи. */
export const TELEGRAM_TEXT_MAX = 4096;
/** Часовий пояс дат у повідомленнях (поки що один для всіх — аудиторія в Україні). */
export const DEFAULT_TIME_ZONE = 'Europe/Kyiv';

export type InlineButton = { text: string; callback_data: string };

export type RenderOptions = {
  /** Базова адреса сайту (фронтенду), без слеша в кінці, напр. `https://nri.example`. */
  siteUrl: string;
  t?: Translate;
  dict?: Record<string, unknown>;
  timeZone?: string;
};

export type Rendered = {
  /** Простий текст: надсилається БЕЗ `parse_mode`, тож `<b>`, `&` тощо — просто символи. */
  text: string;
  /** Рядки inline-клавіатури; `undefined` — без кнопок. */
  keyboard: InlineButton[][] | undefined;
};

const isType = (k: string): k is NotificationType =>
  (NOTIFICATION_TYPES as readonly string[]).includes(k);

/**
 * `пт, 28 листопада о 19:00` у вказаному поясі (невідомий пояс — Europe/Kyiv); зіпсована
 * дата — `null`.
 */
export function formatWhen(iso: string | undefined, timeZone = DEFAULT_TIME_ZONE): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return formatIn(d, timeZone);
  } catch {
    return formatIn(d, DEFAULT_TIME_ZONE);
  }
}

function formatIn(d: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat('uk-UA', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  }).format(d);
  const time = new Intl.DateTimeFormat('uk-UA', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
  return `${date} о ${time}`;
}

/**
 * Текст і кнопки Telegram-сповіщення з `kind` (тип) + `params` (знімок із бекенду):
 * шаблон `notify.<type>` (варіант `_account_deleted` для причини `account_deleted`), для
 * `game.finished` — подяка `thanks.<genreSlug>` (або `thanks.default`), для `rating.*` — строк
 * «Оцінити можна до …» (якщо є `closesAt`), у кінці — посилання
 * на сайт. Значення підставляються як є — без HTML-розмітки (повідомлення йде без `parse_mode`).
 */
export function renderNotification(
  kind: string,
  params: NotificationParams,
  buttons: TelegramButton[] | null,
  opts: RenderOptions,
): Rendered {
  const dict = opts.dict ?? uk;
  const t = opts.t ?? makeT(dict);
  const tz = opts.timeZone ?? DEFAULT_TIME_ZONE;
  const vars: Record<string, string> = {
    game: params.gameTitle || t('notify.unknownGame'),
    actor: params.actor?.nickname || t('notify.someone'),
    when: formatWhen(params.startsAt, tz) ?? t('notify.unknownTime'),
    from: formatWhen(params.from, tz) ?? t('notify.unknownTime'),
    offset: offsetPhrase(params.offsetMin, t),
    ratee: params.ratee?.nickname || t('notify.someone'),
    count: String(params.count ?? 0),
    sanction: params.sanctionType
      ? t(`notify.sanction.types.${params.sanctionType}`)
      : t('notify.sanction.types.unknown'),
    until: formatWhen(params.endsAt ?? undefined, tz) ?? t('notify.unknownTime'),
  };

  const parts: string[] = [];
  if (isType(kind)) {
    const variant = `notify.${kind}_${params.reason ?? ''}`;
    let key =
      params.reason === 'account_deleted' && lookup(dict, variant) !== undefined
        ? variant
        : `notify.${kind}`;
    // Варіанти без частини, якої немає в даних (без «від Хтось», без подвійного пробілу).
    const missing = [
      !params.actor?.nickname && 'noactor',
      params.offsetMin === undefined && 'nooffset',
    ];
    for (const m of missing) {
      if (m && lookup(dict, `${key}_${m}`) !== undefined) key = `${key}_${m}`;
    }
    // Безстрокова санкція — без «до …».
    if (kind === 'sanction.imposed' && !params.endsAt) key = 'notify.sanction.imposed_permanent';
    // Рішення по апеляції — окремий текст для прийнятої й відхиленої.
    if (kind === 'appeal.decided' && params.accepted !== undefined) {
      key = params.accepted ? 'notify.appeal.decided_accepted' : 'notify.appeal.decided_rejected';
    }
    // Відновлення кампейну з донабором — окремий текст.
    if (kind === 'game.resumed' && params.recruit === true) key = 'notify.game.resumed_recruit';
    // Нагадування про дедлайн сесійного набору — з датою сесії.
    if (kind === 'rating.deadline' && params.sessionId !== undefined && params.startsAt) {
      key = 'notify.rating.deadline_session';
    }
    parts.push(t(key, vars));
    // Запрошення/нагадування оцінити: строк — окремим рядком (без дедлайну — без рядка).
    const closes = kind.startsWith('rating.') ? formatWhen(params.closesAt, tz) : null;
    if (closes) parts.push(t('notify.rating.until', { closes }));
    const withReason = ['session.cancelled', 'sanction.imposed', 'appeal.decided'];
    if (withReason.includes(kind) && params.reason) {
      parts.push(t('notify.reason', { reason: params.reason }));
    }
    // Пауза кампейну: причина зі списку й пояснення майстра — окремим рядком.
    if (kind === 'game.paused') {
      const label = params.pauseReason
        ? lookup(dict, `notify.pauseReasons.${params.pauseReason}`)
        : undefined;
      const reason = [label, params.note].filter(Boolean).join(' — ');
      if (reason) parts.push(t('notify.reason', { reason }));
    }
    if (kind === 'game.finished') {
      const thanks = params.genreSlug ? lookup(dict, `thanks.${params.genreSlug}`) : undefined;
      parts.push('', thanks ?? t('thanks.default'));
    }
    const url = `${opts.siteUrl.replace(/\/+$/, '')}${notificationLink(kind, params)}`;
    parts.push('', t('notify.link', { url }));
  } else {
    parts.push(t('notify.generic'));
  }

  let text = parts.join('\n');
  if (text.length > TELEGRAM_TEXT_MAX) text = `${text.slice(0, TELEGRAM_TEXT_MAX - 1)}…`;

  const row = (buttons ?? []).map((b): InlineButton => ({
    text: buttonText(b, t),
    callback_data: encodeCallback(b),
  }));
  return { text, keyboard: row.length ? [row] : undefined };
}

function offsetPhrase(offsetMin: number | undefined, t: Translate): string {
  if (offsetMin === undefined) return '';
  const key = `notify.offset.${offsetMin}`;
  const s = t(key);
  return s === key ? t('notify.offset.other', { n: String(offsetMin) }) : s;
}

function buttonText(b: TelegramButton, t: Translate): string {
  switch (b.action) {
    case 'approve':
      return t('notify.buttons.approve');
    case 'reject':
      return t('notify.buttons.reject');
    case 'rsvp':
      return t(b.value === 'going' ? 'notify.buttons.going' : 'notify.buttons.notGoing');
  }
}
