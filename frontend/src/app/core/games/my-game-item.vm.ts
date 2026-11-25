import type { GameAction, GameStatus, MeDto, MyGameCardDto } from '@nri/shared';
import { differentZones, formatDateTime, viewerTimeZone } from '../i18n/dates';
import type { SeenBadge } from '../views/views.service';

/** Дії-переходи, доступні в кожному статусі (редагування — окремо). */
const ACTIONS: Record<GameStatus, GameAction[]> = {
  draft: ['publish', 'cancel'],
  recruiting: ['start', 'cancel'],
  started: ['finish', 'cancel'],
  finished: [],
  cancelled: [],
};

const EDITABLE = new Set<GameStatus>(['draft', 'recruiting', 'started']);
/** Статуси, у яких у гри можуть бути заявки (чернетка — ще ні). */
const HAS_APPLICATIONS = new Set<GameStatus>(['recruiting', 'started', 'finished', 'cancelled']);

/** Позначка детектора «мертвих» ігор на картці (ключ `games.dead.badge.*`). */
export type DeadFlag = 'stale' | 'dead' | 'suspicious';

/** Дія на рядку «Моїх ігор»: «Все ок», «Закрити», редагування або перехід статусу. */
export type MyGameActionId = 'still-alive' | 'close-dead' | 'edit' | GameAction;

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
  /** Бейдж «Нове» / «Оновлено». */
  seen: SeenBadge | null;
  /** Позначки в порядку важливості. */
  flags: MyGameFlagVm[];
  systemName: string;
  formatKey: string;
  city: string | null;
  kindKey: string;
  /** Найближча сесія в поясі глядача, або `null`. */
  nextSession: string | null;
  freeSlots: number;
  maxPlayers: number;
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
  { me, seen }: MyGameItemVmOptions,
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
  for (const action of ACTIONS[game.status]) {
    actions.push({
      id: action,
      labelKey: `games.actions.${action}`,
      emphasis: 'text',
      danger: action === 'cancel',
      link: null,
    });
  }

  let nextSession: string | null = null;
  if (game.nextSessionAt) {
    const tz = viewerTimeZone(me);
    nextSession = formatDateTime(game.nextSessionAt, tz, {
      showZone: differentZones(tz, game.timezone),
    });
  }

  return {
    id: game.id,
    title: game.title,
    status: game.status,
    statusKey: `games.status.${game.status}`,
    seen,
    flags: deadFlags(game).map((flag) => ({
      flag,
      badgeKey: `games.dead.badge.${flag}`,
      explainKey: `games.dead.explain.${flag}`,
    })),
    systemName: game.system?.name ?? game.systemOther ?? '',
    formatKey: `games.format.${game.format}`,
    city: game.city,
    kindKey: `games.kind.${game.kind}`,
    nextSession,
    freeSlots: game.freeSlots,
    maxPlayers: game.maxPlayers,
    applications: HAS_APPLICATIONS.has(game.status)
      ? { link: ['/games', game.id, 'applications'], pending: game.pendingApplications }
      : null,
    actions,
  };
}
