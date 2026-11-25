import {
  isRestrictedGame,
  type AgeRating,
  type MeDto,
  type RestrictedGameDto,
  type SearchGameCardDto,
} from '@nri/shared';
import { differentZones, formatDateTime, viewerTimeZone } from '../i18n/dates';

/**
 * Бейдж (позначка) для слотів дизайну. `kind` + `value` — семантика (дизайн за ними обирає
 * колір чи форму), `labelKey` — готовий ключ i18n, `icon` — ім'я Material Symbols або `null`.
 */
export interface BadgeVm {
  kind: 'fit' | 'age' | 'status';
  value: string;
  labelKey: string;
  icon: string | null;
}

/**
 * Частина однорядкового підсумку картки («D&D 5e · Кампанія · Фентезі»): готовий текст або
 * ключ i18n. Слот збирає рядок пайпом `nriLine` (частини через « · »).
 */
export type LinePart = { text: string } | { key: string };

/** Майстер гри для слоту «підпис майстра». */
export interface GmSignatureVm {
  publicId: string;
  /** `null` — акаунт видалено. */
  nickname: string | null;
  blocked: boolean;
  /** Загальний рейтинг; `null` — ще немає. */
  rating: number | null;
  /** Показувати рейтинг (на обмеженій картці — ні). */
  showRating: boolean;
}

interface GameCardVmBase {
  id: number;
  title: string;
  badges: BadgeVm[];
  gm: GmSignatureVm;
}

/** Обмежена картка (18+/21+, яку глядач не проходить): лише назва, вік і майстер. */
export interface RestrictedGameCardVm extends GameCardVmBase {
  restricted: true;
  /** Пояснення під блюром (`games.restricted.<вік>`). */
  restrictedKey: string;
  /** Гостю — заклик увійти з поверненням на гру; іншим — `null`. */
  loginReturnTo: string | null;
}

export interface FullGameCardVm extends GameCardVmBase {
  restricted: false;
  coverUrl: string | null;
  systemName: string;
  genreKey: string | null;
  formatKey: string;
  city: string | null;
  kindKey: string;
  languageKey: string;
  /** Найближча сесія й вільні місця мають сенс лише для гри, що набирає чи йде. */
  showSchedule: boolean;
  /** Найближча сесія в поясі глядача (з назвою поясу, якщо він інший), або `null`. */
  nextSession: string | null;
  freeSlots: number;
  maxPlayers: number;
  /** Ціна за сесію; `null` — безкоштовно. */
  priceUah: number | null;
  /** Рядок «система · тип · жанр». */
  systemLine: LinePart[];
  /** Рядок «формат · місто · мова». */
  whereLine: LinePart[];
}

export type GameCardVm = RestrictedGameCardVm | FullGameCardVm;

export interface GameCardVmOptions {
  /** Гість бачить на обмеженій картці заклик увійти. */
  guest: boolean;
  /** Ключ i18n жанру за id (з каталогу). */
  genreKey: (id: number) => string | null;
}

function ageBadge(age: AgeRating): BadgeVm {
  return { kind: 'age', value: age, labelKey: `games.ageRating.${age}`, icon: null };
}

/**
 * Картка гри (пошук, профіль) → дані для слоту «картка гри». Для `RestrictedGameDto` у
 * модель потрапляють лише дозволені поля, навіть якщо в об'єкті випадково є інші.
 */
export function toGameCardVm(
  game: SearchGameCardDto | RestrictedGameDto,
  me: MeDto | null,
  { guest, genreKey }: GameCardVmOptions,
): GameCardVm {
  const gm = (rating: number | null, showRating: boolean): GmSignatureVm => ({
    publicId: game.gm.publicId,
    nickname: game.gm.nickname,
    blocked: game.gm.blocked === true,
    rating,
    showRating,
  });

  if (isRestrictedGame(game)) {
    return {
      restricted: true,
      id: game.id,
      title: game.title,
      badges: [ageBadge(game.ageRating)],
      gm: gm(null, false),
      restrictedKey: `games.restricted.${game.ageRating}`,
      loginReturnTo: guest ? `/games/${game.id}` : null,
    };
  }

  const badges: BadgeVm[] = [];
  if (game.fit) {
    badges.push({
      kind: 'fit',
      value: game.fit,
      labelKey: `search.fit.${game.fit}`,
      icon: game.fit === 'full' ? 'event_available' : 'event_note',
    });
  }
  if (game.ageRating !== 'none') badges.push(ageBadge(game.ageRating));
  if (game.status !== 'recruiting') {
    badges.push({
      kind: 'status',
      value: game.status,
      labelKey: `games.status.${game.status}`,
      icon: null,
    });
  }

  let nextSession: string | null = null;
  if (game.nextSessionAt) {
    // Час — у поясі глядача; назва поясу додається, якщо він відрізняється від поясу гри.
    const tz = viewerTimeZone(me);
    nextSession = formatDateTime(game.nextSessionAt, tz, {
      showZone: differentZones(tz, game.timezone),
    });
  }

  const systemName = game.system?.name ?? game.systemOther ?? '';
  const genre = genreKey(game.genreId);
  const kindKey = `games.kind.${game.kind}`;
  const formatKey = `games.format.${game.format}`;
  const languageKey = `games.language.${game.language}`;

  return {
    restricted: false,
    id: game.id,
    title: game.title,
    badges,
    gm: gm(game.gmRating, true),
    coverUrl: game.coverUrl,
    systemName,
    genreKey: genre,
    formatKey,
    city: game.city,
    kindKey,
    languageKey,
    showSchedule: game.status === 'recruiting' || game.status === 'started',
    nextSession,
    freeSlots: game.freeSlots,
    maxPlayers: game.maxPlayers,
    priceUah: game.priceUah,
    systemLine: [{ text: systemName }, { key: kindKey }, ...(genre ? [{ key: genre }] : [])],
    whereLine: [
      { key: formatKey },
      ...(game.city ? [{ text: game.city }] : []),
      { key: languageKey },
    ],
  };
}
