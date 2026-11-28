import type { GameAction, GameStatus, MeDto, MyGameCardDto } from '@nri/shared';
import { formatWindow, viewerTimeZone } from '../i18n/dates';
import type { SeenBadge } from '../views/views.service';
import type { ViewMode } from '../view-mode/view-mode.store';
import { NO_START_DATE_KEY, type LinePart } from './game-card.vm';
import { toSeatsVm, type SeatsVm } from './seats.vm';

/** Дії-переходи, доступні в кожному статусі (редагування — окремо). */
const ACTIONS: Record<GameStatus, GameAction[]> = {
  draft: ['publish', 'cancel'],
  recruiting: ['start', 'cancel'],
  started: ['finish', 'cancel'],
  // «Відновити» / «Оголосити донабір» — діалог дати першої сесії (див. `PAUSE_ACTIONS`).
  paused: ['resume', 'finish', 'cancel'],
  finished: [],
  cancelled: [],
};

/** Кампейн можна поставити на паузу, поки він набирає чи триває. */
const PAUSABLE = new Set<GameStatus>(['recruiting', 'started']);

const EDITABLE = new Set<GameStatus>(['draft', 'recruiting', 'started', 'paused']);
/** Статуси, у яких у гри можуть бути заявки (чернетка — ще ні). */
const HAS_APPLICATIONS = new Set<GameStatus>([
  'recruiting',
  'started',
  'paused',
  'finished',
  'cancelled',
]);

/** Позначка детектора «мертвих» ігор на картці (ключ `games.dead.badge.*`). */
export type DeadFlag = 'stale' | 'dead' | 'suspicious';

/**
 * Дія на рядку «Моїх ігор»: «Все ок», «Закрити», редагування, перехід статусу або
 * «Оголосити донабір» (відновлення з паузи з донабором).
 */
export type MyGameActionId = 'still-alive' | 'close-dead' | 'edit' | 'recruit' | GameAction;

export interface MyGameActionVm {
  id: MyGameActionId;
  labelKey: string;
  /** Вага кнопки: обведена (основна для рядка) чи текстова. */
  emphasis: 'stroked' | 'text';
  danger: boolean;
  /** Посилання замість кнопки (редагування). */
  link: (string | number)[] | null;
}

export interface MyGameFlagVm {
  flag: DeadFlag;
  badgeKey: string;
  explainKey: string;
}

export interface MyGameItemVm {
  id: number;
  title: string;
  status: GameStatus;
  statusKey: string;
  /** Обкладинка гри; `null` — немає. */
  coverUrl: string | null;
  /** Бейдж «Нове» / «Оновлено». */
  seen: SeenBadge | null;
  /** Позначки в порядку важливості. */
  flags: MyGameFlagVm[];
  systemName: string;
  formatKey: string;
  city: string | null;
  kindKey: string;
  /** Рядок «система · формат · місто · тип». */
  systemLine: LinePart[];
  /** Найближча сесія в поясі глядача, або `null`. */
  nextSession: string | null;
  /**
   * Найближча сесія має приблизний час (вікно): `nextSession` — проміжок, шаблон додає
   * «час уточнюється» (`games.approxTime`).
   */
  nextSessionApprox: boolean;
  /** Ключ підпису, коли найближчої сесії немає (чернетка без дати — «Дату ще не визначено»). */
  noNextKey: string;
  freeSlots: number;
  maxPlayers: number;
  /** Місця за видом (гравцю — зайняті, майстру — вільні): текст і заповнення індикатора. */
  seats: SeatsVm;
  /** Посилання на заявки (крім чернетки) і кількість нових; `null` — без посилання. */
  applications: { link: (string | number)[]; pending: number } | null;
  actions: MyGameActionVm[];
}

/** Подія слоту «рядок моєї гри»: натиснуто дію-кнопку (посилання обробляє роутер). */
export interface MyGameActionEvent {
  action: Exclude<MyGameActionId, 'edit'>;
}

export interface MyGameItemVmOptions {
  me: MeDto | null;
  seen: SeenBadge | null;
  /** «Вид гравця / майстра» — які місця показувати; типово — гравця. */
  viewMode?: ViewMode;
}

/** Позначки гри в порядку важливості. */
export function deadFlags(game: Pick<MyGameCardDto, 'staleness' | 'suspicious'>): DeadFlag[] {
  const flags: DeadFlag[] = [];
  if (game.staleness !== 'ok') flags.push(game.staleness);
  if (game.suspicious) flags.push('suspicious');
  return flags;
}

/**
 * Гра майстра → дані для слоту «рядок моєї гри»: позначки, тексти й доступні дії за статусом.
 * «Все ок» і «Закрити» — лише для «давно не проводилась» / «мертва» («підозріла» — лише
 * пояснення).
 */
export function toMyGameItemVm(
  game: MyGameCardDto,
  { me, seen, viewMode = 'player' }: MyGameItemVmOptions,
): MyGameItemVm {
  const actions: MyGameActionVm[] = [];
  if (game.staleness !== 'ok') {
    actions.push(
      {
        id: 'still-alive',
        labelKey: 'games.dead.stillAlive',
        emphasis: 'stroked',
        danger: false,
        link: null,
      },
      {
        id: 'close-dead',
        labelKey: 'games.dead.close',
        emphasis: 'text',
        danger: true,
        link: null,
      },
    );
  }
  if (EDITABLE.has(game.status)) {
    actions.push({
      id: 'edit',
      labelKey: 'games.actions.edit',
      emphasis: 'stroked',
      danger: false,
      link: ['/games', game.id, 'edit'],
    });
  }
  const transitions: MyGameActionId[] = [...ACTIONS[game.status]];
  if (game.status === 'paused') transitions.splice(1, 0, 'recruit');
  if (game.kind === 'campaign' && PAUSABLE.has(game.status)) {
    transitions.splice(transitions.indexOf('cancel'), 0, 'pause');
  }
  for (const action of transitions) {
    actions.push({
      id: action,
      labelKey: `games.actions.${action}`,
      // Із паузи головна дія — «Відновити».
      emphasis: action === 'resume' ? 'stroked' : 'text',
      danger: action === 'cancel',
      link: null,
    });
  }

  let nextSession: string | null = null;
  if (game.nextSessionAt) {
    // У поясі глядача, без назви поясу (як на картці пошуку).
    nextSession = formatWindow(
      game.nextSessionAt,
      game.nextSessionWindowMinutes,
      viewerTimeZone(me),
    );
  }

  const systemName = game.system?.name ?? game.systemOther ?? '';
  const formatKey = `games.format.${game.format}`;
  const kindKey = `games.kind.${game.kind}`;

  return {
    id: game.id,
    title: game.title,
    status: game.status,
    statusKey: `games.status.${game.status}`,
    coverUrl: game.coverUrl,
    seen,
    flags: deadFlags(game).map((flag) => ({
      flag,
      badgeKey: `games.dead.badge.${flag}`,
      explainKey: `games.dead.explain.${flag}`,
    })),
    systemName,
    formatKey,
    city: game.city,
    kindKey,
    systemLine: [
      { text: systemName },
      { key: formatKey },
      ...(game.city ? [{ text: game.city }] : []),
      { key: kindKey },
    ],
    nextSession,
    nextSessionApprox: nextSession !== null && game.nextSessionWindowMinutes !== null,
    noNextKey: game.startsAt === null ? NO_START_DATE_KEY : 'games.my.noNextSession',
    freeSlots: game.freeSlots,
    maxPlayers: game.maxPlayers,
    seats: toSeatsVm(game.freeSlots, game.maxPlayers, viewMode),
    applications: HAS_APPLICATIONS.has(game.status)
      ? { link: ['/games', game.id, 'applications'], pending: game.pendingApplications }
      : null,
    actions,
  };
}
