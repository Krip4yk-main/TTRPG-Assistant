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
  return `${dateIn(d, timeZone)} о ${timeIn(d, timeZone)}`;
}

function dateIn(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  }).format(d);
}

function timeIn(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}

const MINUTE_MS = 60_000;

/**
 * Час сесії для тексту: з вікном початку (`windowMinutes`) — `пт, 28 листопада, початок між
 * 19:00 і 21:00` (шаблон `notify.window`, через північ — `notify.window_overnight` з «наступного
 * дня»; кінець вікна — у UTC-мілісекундах, тож перехід на
 * літній час його не зсуває), без вікна — як `formatWhen`. Зіпсована дата — `null`.
 */
export function formatWhenWindow(
  iso: string | undefined,
  windowMinutes: number | null | undefined,
  t: Translate,
  timeZone = DEFAULT_TIME_ZONE,
): string | null {
  if (!windowMinutes) return formatWhen(iso, timeZone);
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const end = new Date(d.getTime() + windowMinutes * MINUTE_MS);
  // Вікно через північ (≤ 12 год — кінець щонайбільше наступного дня): «… наступного дня».
  const render = (zone: string) => {
    const date = dateIn(d, zone);
    const key = dateIn(end, zone) === date ? 'notify.window' : 'notify.window_overnight';
    return t(key, { date, start: timeIn(d, zone), end: timeIn(end, zone) });
  };
  try {
    return render(timeZone);
  } catch {
    return render(DEFAULT_TIME_ZONE);
  }
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
    when:
      formatWhenWindow(params.startsAt, params.startWindowMinutes, t, tz) ??
      t('notify.unknownTime'),
    from: formatWhenWindow(params.from, params.fromWindowMinutes, t, tz) ?? t('notify.unknownTime'),
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
    // Нагадування про календар тому, хто підключив лише імпорт iCal: «додай звичні години».
    if (kind === 'calendar.empty' && params.hasImport === true)
      key = 'notify.calendar.empty_imported';
    // Майстер уточнив приблизний час (з вікна — на точний) — окремий текст.
    if (kind === 'session.rescheduled' && params.fromWindowMinutes && !params.startWindowMinutes) {
      key = 'notify.session.rescheduled_pinned';
    }
    // «Не буду» кількох учасників одним сповіщенням — «X та ще N».
    if (kind === 'session.rsvp_declined' && (params.count ?? 0) > 0) {
      key = 'notify.session.rsvp_declined_many';
    }
    // Голосування за час: окремий текст для регулярного; закриття — за причиною й переможцем.
    if (kind === 'poll.created' && params.pollKind === 'regular')
      key = 'notify.poll.created_regular';
    if (kind === 'poll.closed') {
      key = !params.startsAt
        ? 'notify.poll.closed_nowinner'
        : params.closeReason === 'all_voted' || params.closeReason === 'deadline'
          ? `notify.poll.closed_${params.closeReason}`
          : 'notify.poll.closed';
    }
    parts.push(t(key, vars));
    if (kind === 'poll.created') {
      const optionKey =
        params.pollKind === 'regular' ? 'notify.poll.option_regular' : 'notify.poll.option';
      const lines = (params.pollOptions ?? []).map((o) =>
        t(optionKey, {
          n: String(o.n),
          when: formatWhen(o.startsAt, tz) ?? t('notify.unknownTime'),
        }),
      );
      if (lines.length) parts.push('', ...lines);
      const closes = formatWhen(params.closesAt, tz);
      if (closes) parts.push('', t('notify.poll.until', { closes }));
    }
    // Підсумок сесії: початок тексту майстра — окремим абзацом (як є, без розмітки).
    if (kind === 'session.summary' && params.excerpt) parts.push('', params.excerpt);
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

  // Кнопки голосування — по рядку на варіант; решта — один рядок.
  const rows: InlineButton[][] = [];
  const voteRow = new Map<number, InlineButton[]>();
  const plain: InlineButton[] = [];
  for (const b of buttons ?? []) {
    const btn = { text: buttonText(b, t), callback_data: encodeCallback(b) };
    if (b.action !== 'vote') {
      plain.push(btn);
      continue;
    }
    let row = voteRow.get(b.optionId);
    if (!row) {
      row = [];
      voteRow.set(b.optionId, row);
      rows.push(row);
    }
    row.push(btn);
  }
  if (plain.length) rows.unshift(plain);
  return { text, keyboard: rows.length ? rows : undefined };
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
    case 'vote':
      return t(`notify.buttons.vote.${b.value}`, { n: String(b.n) });
  }
}
