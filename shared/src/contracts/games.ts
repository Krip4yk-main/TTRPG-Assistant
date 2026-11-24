import { z } from 'zod';
import type { AgeRating } from '../age.js';
import { availabilityInputSchema } from './availability.js';
import { toZoned, type Weekday } from '../schedule/tz.js';
import type { Recurrence } from '../schedule/occurrences.js';

export const GAME_FORMATS = ['online', 'offline'] as const;
export type GameFormat = (typeof GAME_FORMATS)[number];

export const GAME_KINDS = ['oneshot', 'campaign'] as const;
export type GameKind = (typeof GAME_KINDS)[number];

export const RECURRENCES = [
  'none',
  'weekly',
  'biweekly',
  'monthly',
] as const satisfies readonly Recurrence[];

export const AGE_RATINGS = ['none', '18+', '21+'] as const satisfies readonly AgeRating[];

export const GAME_EXPERIENCE = ['any', 'beginner', 'experienced'] as const;
export type GameExperience = (typeof GAME_EXPERIENCE)[number];

export const GAME_LANGUAGES = ['uk', 'en'] as const;
export type GameLanguage = (typeof GAME_LANGUAGES)[number];

export const GAME_STATUSES = ['draft', 'recruiting', 'started', 'finished', 'cancelled'] as const;
export type GameStatus = (typeof GAME_STATUSES)[number];

/** Поля, які в `recruiting`/`started` змінювати не можна (рішення власника). */
export const GAME_LOCKED_AFTER_PUBLISH = ['systemId', 'systemOther', 'kind'] as const;

export interface ChannelLink {
  label: string;
  url: string;
}

const MINUTE_MS = 60_000;

/** `''` → `null` для необов'язкових текстових полів. */
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((s) => (s === '' ? null : s));

const httpsUrl = z.url({ protocol: /^https$/ }).max(512);

const startsAt = z.iso
  .datetime({ offset: true })
  .refine((s) => new Date(s).getTime() % MINUTE_MS === 0, 'startsAt must be a whole minute')
  .transform((s) => new Date(s).toISOString());

const uniqueSorted = <T extends number>(xs: T[]): T[] => [...new Set(xs)].sort((a, b) => a - b);

const shape = {
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(5000),
  systemId: z.number().int().positive().nullable(),
  systemOther: optText(80),
  genreId: z.number().int().positive(),
  format: z.enum(GAME_FORMATS),
  city: optText(80),
  address: optText(255),
  platform: optText(60),
  kind: z.enum(GAME_KINDS),
  startsAt,
  durationMinutes: z.number().int().min(30).max(720).multipleOf(30),
  recurrence: z.enum(RECURRENCES),
  weekdays: z
    .array(z.number().int().min(0).max(6))
    .max(7)
    .transform((w) => uniqueSorted(w as Weekday[])),
  minPlayers: z.number().int().min(1).max(20),
  maxPlayers: z.number().int().min(1).max(20),
  /** `null` (або 0) — безкоштовно; грн за сесію. */
  priceUah: z
    .number()
    .int()
    .min(0)
    .max(100_000)
    .nullable()
    .transform((p) => (p === 0 ? null : p)),
  ageRating: z.enum(AGE_RATINGS),
  experience: z.enum(GAME_EXPERIENCE),
  language: z.enum(GAME_LANGUAGES),
  requirements: optText(2000),
  coverUrl: httpsUrl.nullable(),
  channelLinks: z
    .array(z.object({ label: z.string().trim().min(1).max(40), url: httpsUrl }).strict())
    .max(5),
  applicationQuestions: z.array(z.string().trim().min(1).max(300)).max(10),
  customWarnings: z.array(z.string().trim().min(1).max(60)).max(10),
  contentWarningIds: z
    .array(z.number().int().positive())
    .max(30)
    .transform((ids) => uniqueSorted(ids)),
  showWhenFull: z.boolean(),
};

const gameObject = z.object(shape).strict();

/** Значення необов'язкових полів при створенні. */
const GAME_DEFAULTS = {
  description: '',
  systemId: null,
  systemOther: null,
  city: null,
  address: null,
  platform: null,
  recurrence: 'none',
  weekdays: [],
  priceUah: null,
  ageRating: 'none',
  experience: 'any',
  language: 'uk',
  requirements: null,
  coverUrl: null,
  channelLinks: [],
  applicationQuestions: [],
  customWarnings: [],
  contentWarningIds: [],
  showWhenFull: false,
} as const satisfies Partial<z.output<typeof gameObject>>;

/** Нормалізовані поля гри (вихід `gameInputSchema`). */
export type GameInput = z.output<typeof gameObject>;

/**
 * Повна валідація гри. `timezone` — пояс гри (майстра на момент створення), потрібен для
 * перевірки, що день тижня першої сесії входить у `weekdays`.
 * Правила: рівно одне з `systemId`/`systemOther`; offline → `city`; `oneshot` → лише `none`;
 * weekly/biweekly → непорожні `weekdays`, що містять день `startsAt`; none/monthly → `[]`;
 * `minPlayers ≤ maxPlayers`; `startsAt` — ціла хвилина.
 */
export function gameInputSchema(timezone: string) {
  return gameObject
    .partial(
      Object.fromEntries(Object.keys(GAME_DEFAULTS).map((k) => [k, true])) as {
        [K in keyof typeof GAME_DEFAULTS]: true;
      },
    )
    .transform((v): GameInput => ({ ...GAME_DEFAULTS, ...v }) as GameInput)
    .superRefine((g, ctx) => {
      const issue = (path: keyof GameInput, message: string) =>
        ctx.addIssue({ code: 'custom', path: [path], message });
      if ((g.systemId === null) === (g.systemOther === null)) {
        issue('systemId', 'Exactly one of systemId/systemOther is required');
      }
      if (g.format === 'offline' && g.city === null) issue('city', 'City is required offline');
      if (g.kind === 'oneshot' && g.recurrence !== 'none') {
        issue('recurrence', 'Oneshot cannot recur');
      }
      if (g.recurrence === 'weekly' || g.recurrence === 'biweekly') {
        const wd = toZoned(new Date(g.startsAt), timezone).weekday;
        if (!g.weekdays.includes(wd)) {
          issue('weekdays', 'Weekdays must include the weekday of startsAt');
        }
      } else if (g.weekdays.length > 0) {
        issue('weekdays', 'Weekdays apply only to weekly/biweekly');
      }
      if (g.minPlayers > g.maxPlayers) issue('minPlayers', 'minPlayers must be ≤ maxPlayers');
    });
}

/**
 * Часткове оновлення (`PATCH`): перевіряє лише форму переданих полів. Бекенд зливає
 * патч із поточною грою й валідує результат через `gameInputSchema`.
 */
export const gamePatchSchema = gameObject.partial();
export type GamePatch = z.output<typeof gamePatchSchema>;

export interface GameGmDto {
  publicId: string;
  nickname: string | null;
  avatarUrl: string | null;
}

export interface GameSystemRefDto {
  id: number;
  name: string;
}

/** Картка гри (пошук, профілі, «Мої ігри»). */
export interface GameCardDto {
  id: number;
  title: string;
  coverUrl: string | null;
  /** `null` — система «Інша», див. `systemOther`. */
  system: GameSystemRefDto | null;
  systemOther: string | null;
  genreId: number;
  gm: GameGmDto;
  format: GameFormat;
  city: string | null;
  /** Найближча сесія ≥ зараз (ISO UTC), `null` — немає. */
  nextSessionAt: string | null;
  /** `maxPlayers − учасники`, не менше 0. */
  freeSlots: number;
  maxPlayers: number;
  priceUah: number | null;
  ageRating: AgeRating;
  kind: GameKind;
  language: GameLanguage;
  status: GameStatus;
}

/** Вид гри 18+/21+ для гостя чи молодшого за вікову позначку — рівно ці ключі. */
export interface RestrictedGameDto {
  id: number;
  title: string;
  gm: GameGmDto;
  ageRating: AgeRating;
  restricted: true;
}

/** Повна гра — для майстра й учасників (`game_members`). */
export interface GameDto extends Omit<GameInput, 'systemId'> {
  id: number;
  system: GameSystemRefDto | null;
  gm: GameGmDto;
  timezone: string;
  status: GameStatus;
  nextSessionAt: string | null;
  freeSlots: number;
  publishedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Приватні поля гри: лише майстру й учасникам. */
export const GAME_PRIVATE_FIELDS = ['address', 'channelLinks'] as const;

/** Публічний повний вид (сторонній користувач, що проходить вікову позначку). */
export type PublicGameDto = Omit<GameDto, (typeof GAME_PRIVATE_FIELDS)[number]>;

/** Відповідь `GET /api/games/:id`. */
export type GameViewDto = GameDto | PublicGameDto | RestrictedGameDto;

export const isRestrictedGame = (g: object): g is RestrictedGameDto =>
  'restricted' in g && g.restricted === true;

// ---------- пошук ----------

export const SEARCH_SORTS = ['soonest', 'newest'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export const PRICE_MODES = ['any', 'free', 'paid'] as const;

/** Необов'язковий рядок-фільтр: обрізається, порожній → відсутній. */
const optFilter = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((s) => (s ? s : undefined));

const idList = z.array(z.number().int().positive()).max(50);

const calendarSchema = z
  .object({
    mode: z.enum(['off', 'mine', 'custom']),
    availability: availabilityInputSchema.optional(),
    includePartial: z.boolean().default(false),
  })
  .strict()
  .refine((c) => (c.mode === 'custom') === (c.availability !== undefined), {
    message: 'availability is required for custom mode and only allowed there',
    path: ['availability'],
  });

/**
 * Тіло `POST /api/games/search`.
 * - `city`, `platform` — точний збіг без урахування регістру;
 * - `experience` — ігри з цим рівнем або з `any`;
 * - `priceMode: 'free'` — лише безкоштовні; `priceMax` — ціна ≤ max (з `any` — ще й безкоштовні);
 * - `dateFrom`/`dateTo` — момент часу (ISO з поясом): є сесія в `[max(dateFrom, зараз), dateTo)`;
 * - `calendar` — фільтр відповідності календарю гравця на 4 тижні (`FIT_HORIZON_DAYS`):
 *   `full` проходить завжди, `partial` — лише з `includePartial`;
 * - `cursor` — непрозорий рядок з `nextCursor` попередньої сторінки (з тим самим `sort`).
 */
export const searchFiltersSchema = z
  .object({
    systemIds: idList.optional(),
    genreIds: idList.optional(),
    format: z.enum(GAME_FORMATS).optional(),
    city: optFilter(80),
    kind: z.enum(GAME_KINDS).optional(),
    dateFrom: z.iso.datetime({ offset: true }).optional(),
    dateTo: z.iso.datetime({ offset: true }).optional(),
    priceMode: z.enum(PRICE_MODES).default('any'),
    priceMax: z.number().int().min(0).max(100_000).optional(),
    ageRatings: z.array(z.enum(AGE_RATINGS)).max(3).optional(),
    experience: z.enum(GAME_EXPERIENCE).optional(),
    platform: optFilter(60),
    language: z.enum(GAME_LANGUAGES).optional(),
    hasFreeSlots: z.boolean().optional(),
    excludeWarningIds: idList.optional(),
    calendar: calendarSchema.default({ mode: 'off', includePartial: false }),
    sort: z.enum(SEARCH_SORTS).default('soonest'),
    cursor: z.string().max(512).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict()
  .refine((f) => !f.dateFrom || !f.dateTo || new Date(f.dateFrom) < new Date(f.dateTo), {
    message: 'dateFrom must be before dateTo',
    path: ['dateTo'],
  });

export type SearchFilters = z.output<typeof searchFiltersSchema>;
export type SearchFiltersInput = z.input<typeof searchFiltersSchema>;

/** Картка в результатах пошуку; `fit` — лише коли увімкнено календарний фільтр. */
export type SearchGameCardDto = GameCardDto & { fit?: 'full' | 'partial' };

/** Відповідь `POST /api/games/search`. */
export interface SearchResultDto {
  items: (SearchGameCardDto | RestrictedGameDto)[];
  /** `null` — сторінок більше немає. */
  nextCursor: string | null;
}
