import {
  isRestrictedGame,
  type AgeRating,
  type MeDto,
  type RestrictedGameDto,
  type SearchGameCardDto,
} from '@nri/shared';
import { formatWindow, viewerTimeZone } from '../i18n/dates';
import type { ViewMode } from '../view-mode/view-mode.store';
import { toSeatsVm, type SeatsVm } from './seats.vm';

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

/** Обмежена картка (16+/18+/21+, яку глядач не проходить): лише назва, вік і майстер. */
export interface RestrictedGameCardVm extends GameCardVmBase {
  restricted: true;
  /** Пояснення під блюром (`games.restricted.<вік>`). */
  restrictedKey: string;
  /** Гостю — заклик увійти з поверненням на гру; іншим — `null`. */
  loginReturnTo: string | null;
}

export interface FullGameCardVm extends GameCardVmBase {
  restricted: false;
  /** Короткий опис (бекенд уже обрізав його до ~200 символів); `null` — опису немає. */
  summary: string | null;
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
  /**
   * Найближча сесія має приблизний час (вікно): `nextSession` — проміжок, шаблон додає
   * «час уточнюється» (`games.approxTime`).
   */
  nextSessionApprox: boolean;
  freeSlots: number;
  maxPlayers: number;
  /** Місця за видом (гравцю — зайняті, майстру — вільні): текст і заповнення індикатора. */
  seats: SeatsVm;
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
  /** «Вид гравця / майстра» — які місця показувати; типово — гравця. */
  viewMode?: ViewMode;
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
  { guest, genreKey, viewMode = 'player' }: GameCardVmOptions,
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
      // «На паузі» — зі значком, щоб не сплутати з завершеною грою в будь-якому дизайні.
      icon: game.status === 'paused' ? 'pause_circle' : null,
    });
  }

  let nextSession: string | null = null;
  if (game.nextSessionAt) {
    // Час — у поясі глядача (акаунта або браузера) і без назви поясу: на картці «Коли» завжди
    // «по-вашому»; пояс гри видно на сторінці гри.
    nextSession = formatWindow(
      game.nextSessionAt,
      game.nextSessionWindowMinutes,
      viewerTimeZone(me),
    );
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
    summary: game.summary?.trim() || null,
    coverUrl: game.coverUrl,
    systemName,
    genreKey: genre,
    formatKey,
    city: game.city,
    kindKey,
    languageKey,
    showSchedule: game.status === 'recruiting' || game.status === 'started',
    nextSession,
    nextSessionApprox: nextSession !== null && game.nextSessionWindowMinutes !== null,
    freeSlots: game.freeSlots,
    maxPlayers: game.maxPlayers,
    seats: toSeatsVm(game.freeSlots, game.maxPlayers, viewMode),
    priceUah: game.priceUah,
    systemLine: [{ text: systemName }, { key: kindKey }, ...(genre ? [{ key: genre }] : [])],
    whereLine: [
      { key: formatKey },
      ...(game.city ? [{ text: game.city }] : []),
      { key: languageKey },
    ],
  };
}
