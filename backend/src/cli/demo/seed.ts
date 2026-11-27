import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  ageOn,
  criteriaForRole,
  expandOccurrences,
  FINAL_RATING_WINDOW_DAYS,
  gameInputSchema,
  localDate,
  meetsAgeRating,
  SESSION_RATING_WINDOW_DAYS,
  SESSION_WINDOW_DAYS,
  toZoned,
  zonedToUtc,
  type AgeRating,
  type GameExperience,
  type GameFormat,
  type GameKind,
  type GameLanguage,
  type GameStatus,
  type NotificationCategory,
  type NotificationParams,
  type NotificationType,
  type RatingCriterion,
  type RatingRole,
  type Recurrence,
  type Weekday,
} from '@nri/shared';
import type { Db } from '../../db/client.js';
import type { Tx } from '../../applications/applications.rules.js';
import {
  applicationConstraintResponses,
  authIdentities,
  availabilityBusyDates,
  availabilitySlots,
  complaints,
  contentWarnings,
  demoEntities,
  gameApplications,
  gameBans,
  gameContentWarnings,
  gameMembers,
  games,
  gameSessions,
  gameStalenessLog,
  gameSystems,
  genres,
  gmBlacklist,
  moderationLog,
  notes,
  notifications,
  publishedRatings,
  ratings,
  sanctionAppeals,
  sanctions,
  sessionAttendance,
  sessionRsvp,
  userProfiles,
  users,
} from '../../db/schema/index.js';
import {
  overlapRule,
  sessionAnchors,
  staleAnchor,
  staleInputOf,
  staleRule,
} from '../../games/dead-games/rules.js';
import { maybePublish } from '../../ratings/ratings.service.js';
import { PUBLIC_ID_ALPHABET, PUBLIC_ID_LENGTH } from '../../users/nickname.js';
import { Deck, Rng, hashSeed } from './random.js';
import { checkRatingSnapshots, type SnapshotIssue } from './ratings-check.js';
import { DEMO_IDENTITY_MARKER, findDemo, hasDemo, resetDemoTx } from './reset.js';
import * as T from './texts.js';

// ---------- параметри й запобіжник ----------

export const DEFAULT_OWNER_NICKNAME = 'Дошка_Власник';
export const DEFAULT_SEED = hashSeed('nri-demo-v1');

export interface SeedDemoOptions {
  /** Множник обсягів (1 ≈ 120 користувачів, 125 ігор). */
  scale?: number;
  seed?: number;
  /** «Зараз» для всіх часових міток (UTC). */
  now?: Date;
  /** Спершу прибрати наявні демо-дані; без нього наявні демо-дані → помилка. */
  reset?: boolean;
  /** Власник, якому дістаються ~50 демо-ігор (якщо такий користувач є). */
  ownerNickname?: string;
  /**
   * ЛИШЕ для тестів: пропустити перевірку NODE_ENV=development і імені БД (тести працюють
   * з `nri_test*` і NODE_ENV=test). CLI цього не передає.
   */
  unsafeSkipTargetGuard?: boolean;
  /** Адреса фронтенду (PUBLIC_BASE_URL): канали демо-ігор ведуть на її сторінку 404. */
  publicBaseUrl?: string;
  /** Хост БД з DATABASE_URL (CLI); перевіряється, що він локальний. */
  dbHost?: string;
  /** Явний дозвіл на нелокальний хост (`--allow-remote`). */
  allowRemote?: boolean;
  /** ЛИШЕ для тестів: точки ін'єкції збою (перевірка, що транзакція нічого не лишає). */
  testHooks?: { afterGames?: () => void | Promise<void> };
  log?: (msg: string) => void;
}

export interface DemoAccount {
  label: string;
  nickname: string;
}

export interface SeedDemoResult {
  counts: Record<string, number>;
  accounts: DemoAccount[];
  ownerId: number | null;
  ownerGameIds: number[];
  demoUserIds: number[];
  ratingIssues: SnapshotIssue[];
}

/** Локальні хости БД: loopback і сервіс docker compose (`mysql`). */
export const LOCAL_DB_HOSTS = [
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  'mysql',
  'host.docker.internal',
];

export interface DevTarget {
  nodeEnv: string | undefined;
  dbName: string | null;
  /** Хост з DATABASE_URL; невідомий — відмова (без `allowRemote`). */
  host: string | undefined;
  allowRemote?: boolean;
}

/** Хост з URL підключення (сам URL ніде не друкується). */
export function dbHostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** Відмова працювати поза локальною розробкою, на тестовій чи нелокальній БД. */
export function assertDevTarget({ nodeEnv, dbName, host, allowRemote }: DevTarget): void {
  if (nodeEnv !== 'development') {
    throw new Error(`refusing to seed: NODE_ENV must be "development" (got "${nodeEnv ?? ''}")`);
  }
  if (!dbName) throw new Error('refusing to seed: no database selected');
  if (dbName.toLowerCase().startsWith('nri_test')) {
    throw new Error(`refusing to seed: "${dbName}" looks like a test database`);
  }
  if (!allowRemote && (!host || !LOCAL_DB_HOSTS.includes(host.toLowerCase()))) {
    throw new Error(
      'refusing to seed: database host is not local (pass --allow-remote to override)',
    );
  }
}

export async function currentDatabase(db: Db | Tx): Promise<string | null> {
  const [rows] = (await db.execute(sql`select database() as name`)) as unknown as [
    { name: string | null }[],
  ];
  return rows[0]?.name ?? null;
}

// ---------- модель ----------

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Час без мілісекунд: datetime(0) у MySQL округлює, а не відкидає. */
const at = (ms: number) => new Date(Math.floor(ms / SEC) * SEC);

interface DUser {
  id: number;
  publicId: string;
  nickname: string;
  birthDate: string;
  timezone: string;
  createdAt: Date;
  city: string | null;
  role: 'user' | 'moderator' | 'admin' | 'owner';
  isGm: boolean;
  isOwner: boolean;
  /** Наскільки часто грає (вага вибору). */
  activity: number;
  /** Імовірність прийти на сесію. */
  reliability: number;
  /** Якість майстра (середня оцінка). */
  quality: number;
  prefersOffline: boolean;
  bannedAt: Date | null;
}

type Special = 'dead' | 'stale' | 'overlap' | null;

interface DSession {
  id: number;
  startsAt: Date;
  ruleStartsAt: Date | null;
  durationMinutes: number;
  status: 'scheduled' | 'done' | 'cancelled';
  origin: 'rule' | 'manual';
  rescheduled: boolean;
  cancelReason: string | null;
  /** Скасування майстром (не авто) — коли. */
  cancelledAt: Date | null;
  summary: string | null;
  doneAt: Date | null;
  createdAt: Date;
  /** Присутні гравці (без майстра); для `done`. */
  present: number[];
  hasAttendance: boolean;
}

interface DMember {
  id: number;
  userId: number;
  applicationKey: number;
  joinedAt: Date;
  leftAt: Date | null;
  leftReason: 'left' | 'kicked' | 'banned' | 'banned_by_admin' | null;
  leaveNoteGm: string | null;
}

interface DApp {
  key: number;
  id: number;
  userId: number;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'cancelled';
  cancelReason: 'game_cancelled' | 'game_finished' | 'banned' | null;
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: number | null;
  message: string | null;
  answers: string[];
  constraints: { id: string; text: string }[];
  responses: {
    constraintId: string;
    response: 'accepted' | 'partial' | 'cannot_guarantee';
    comment: string | null;
  }[];
}

interface DGame {
  id: number;
  gm: DUser;
  isOwnerGame: boolean;
  special: Special;
  title: string;
  description: string;
  systemId: number | null;
  systemOther: string | null;
  genreId: number;
  genreSlug: string;
  praise: readonly string[];
  format: GameFormat;
  city: string | null;
  address: string | null;
  platform: string | null;
  kind: GameKind;
  startsAt: Date;
  durationMinutes: number;
  recurrence: Recurrence;
  weekdays: Weekday[];
  timezone: string;
  minPlayers: number;
  maxPlayers: number;
  priceUah: number | null;
  ageRating: AgeRating;
  experience: GameExperience;
  language: GameLanguage;
  requirements: string | null;
  applicationQuestions: string[];
  customWarnings: string[];
  contentWarningIds: number[];
  showWhenFull: boolean;
  coverUrl: string | null;
  channelLinks: { label: string; url: string }[];
  status: GameStatus;
  createdAt: Date;
  publishedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  cancelledAt: Date | null;
  /** Кінець «життя» гри для подій (завершення/скасування або `now`). */
  endAt: Date;
  /** Скільки слотів розкладу зіграно (завершена кампанія). */
  played: number;
  /** Для «застарілої»: остання проведена сесія. */
  lastDoneAt: Date | null;
  sessions: DSession[];
  apps: DApp[];
  members: DMember[];
}

interface DRating {
  raterId: number;
  rateeId: number;
  gameId: number;
  sessionId: number | null;
  role: RatingRole;
  declined: boolean;
  overall: number | null;
  criteria: Partial<Record<RatingCriterion, number>> | null;
  comment: string | null;
  createdAt: Date;
}

interface DNotification {
  userId: number;
  type: NotificationType;
  category: NotificationCategory;
  params: NotificationParams;
  entityType: string | null;
  entityId: number | null;
  createdAt: Date;
}

const CHUNK = 400;
function chunk<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const foldKey = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const NICK_RE = /^[\p{L}\p{N}_.-]{3,32}$/u;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Таблиці зведення (рядків у всій таблиці). */
export const SUMMARY_TABLES = [
  'users',
  'auth_identities',
  'user_profiles',
  'availability_slots',
  'availability_busy_dates',
  'games',
  'game_content_warnings',
  'game_sessions',
  'game_applications',
  'application_constraint_responses',
  'game_members',
  'session_attendance',
  'session_rsvp',
  'game_bans',
  'gm_blacklist',
  'notes',
  'ratings',
  'published_ratings',
  'complaints',
  'sanctions',
  'sanction_appeals',
  'moderation_log',
  'notifications',
  'game_staleness_log',
] as const;

export async function tableCounts(db: Db | Tx): Promise<Record<string, number>> {
  const query = SUMMARY_TABLES.map((t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM \`${t}\``).join(
    ' UNION ALL ',
  );
  const [rows] = (await db.execute(sql.raw(query))) as unknown as [{ t: string; n: number }[]];
  return Object.fromEntries(rows.map((r) => [r.t, Number(r.n)]));
}

// ---------- головна ----------

/**
 * Наповнює dev-БД реалістичними демо-даними (див. backend/src/cli/seed-demo.ts). Пише
 * напряму в таблиці з історичними часовими мітками, повторюючи те, що роблять сервіси
 * (сесії — `expandOccurrences` як у матеріалізації; зрізи рейтингу — справжній
 * `maybePublish` після кожної оцінки за зростанням id; «мертві»/«підозрілі» ігри — правила
 * детектора `staleRule`/`overlapRule`). Події не пишуться, сповіщення —
 * одразу рядками `notifications` без Telegram-черги.
 */
export async function seedDemo(db: Db, options: SeedDemoOptions = {}): Promise<SeedDemoResult> {
  const log = options.log ?? (() => {});
  if (!options.unsafeSkipTargetGuard) {
    assertDevTarget({
      nodeEnv: process.env.NODE_ENV,
      dbName: await currentDatabase(db),
      host: options.dbHost,
      allowRemote: options.allowRemote,
    });
  }
  // Усе — одна транзакція: збій посередині не лишає ні часткових даних, ні «осиротілих» ігор
  // власника; прибирання (`--reset`) відкочується разом із ним.
  return db.transaction(async (tx) => {
    const existing = await findDemo(tx);
    if (hasDemo(existing)) {
      if (!options.reset) {
        throw new Error('demo data already exists; rerun with --reset to replace it');
      }
      log(
        `reset: removing ${existing.userIds.length} demo users, ${existing.gameIds.length} demo games`,
      );
    }
    // Порожній реєстр без даних теж чиститься.
    await resetDemoTx(tx);
    const seeder = new Seeder(tx, {
      scale: options.scale ?? 1,
      seed: options.seed ?? DEFAULT_SEED,
      now: at((options.now ?? new Date()).getTime()),
      ownerNickname: options.ownerNickname ?? DEFAULT_OWNER_NICKNAME,
      publicBaseUrl: (options.publicBaseUrl || 'http://localhost:4200').replace(/\/+$/, ''),
      log,
      hooks: options.testHooks ?? {},
    });
    return seeder.run();
  });
}

interface Catalog {
  systems: { id: number; slug: string; name: string; defaultGenreId: number }[];
  genres: { id: number; slug: string }[];
  warnings: { id: number; slug: string }[];
}

class Seeder {
  private readonly rng: Rng;
  private readonly now: Date;
  private readonly scale: number;
  private catalog!: Catalog;
  private people: DUser[] = [];
  private owner: DUser | null = null;
  private adminActorId: number | null = null;
  private gms: DUser[] = [];
  private moderators: DUser[] = [];
  private banned: DUser | null = null;
  private plans: DGame[] = [];
  private notifs: DNotification[] = [];
  private appKey = 0;
  private usedTitles = new Set<string>();
  private sanctionNotes: { label: string; nickname: string }[] = [];

  constructor(
    private readonly db: Tx,
    private readonly opts: {
      scale: number;
      seed: number;
      now: Date;
      ownerNickname: string;
      publicBaseUrl: string;
      log: (m: string) => void;
      hooks: NonNullable<SeedDemoOptions['testHooks']>;
    },
  ) {
    this.rng = new Rng(opts.seed);
    this.now = opts.now;
    this.scale = Math.max(0.05, opts.scale);
  }

  private n(base: number, min: number): number {
    return Math.max(min, Math.round(base * this.scale));
  }

  async run(): Promise<SeedDemoResult> {
    const { log } = this.opts;
    await this.loadCatalog();
    await this.loadOwner();
    await this.createUsers();
    log(`users: ${this.people.length} (+owner: ${this.owner ? 'yes' : 'no'})`);
    this.planGames();
    this.planPeopleInGames();
    this.applyBanCascade();
    await this.insertGames();
    log(`games: ${this.plans.length}`);
    await this.opts.hooks.afterGames?.();
    await this.insertNotes();
    await this.insertBlacklist();
    const ratingCount = await this.insertRatings();
    log(`ratings: ${ratingCount}`);
    await this.insertModeration();
    await this.flagStaleGames();
    this.planActivityNotifications();
    await this.insertNotifications();
    const ownerGameIds = this.plans.filter((g) => g.isOwnerGame).map((g) => g.id);
    const demoUserIds = this.people.map((p) => p.id);
    const ratingIssues = await checkRatingSnapshots(this.db, [
      ...demoUserIds,
      ...(this.owner ? [this.owner.id] : []),
    ]);
    return {
      counts: await tableCounts(this.db),
      accounts: await this.interestingAccounts(),
      ownerId: this.owner?.id ?? null,
      ownerGameIds,
      demoUserIds,
      ratingIssues,
    };
  }

  // ---------- каталог і власник ----------

  private async loadCatalog(): Promise<void> {
    const systems = await this.db
      .select({
        id: gameSystems.id,
        slug: gameSystems.slug,
        name: gameSystems.name,
        defaultGenreId: gameSystems.defaultGenreId,
      })
      .from(gameSystems)
      .where(eq(gameSystems.isActive, true))
      .orderBy(gameSystems.sort, gameSystems.id);
    const genreRows = await this.db
      .select({ id: genres.id, slug: genres.slug })
      .from(genres)
      .orderBy(genres.sort);
    const warnings = await this.db
      .select({ id: contentWarnings.id, slug: contentWarnings.slug })
      .from(contentWarnings)
      .orderBy(contentWarnings.sort);
    if (systems.length === 0 || genreRows.length === 0) {
      throw new Error('catalog is empty: run migrations first');
    }
    this.catalog = { systems, genres: genreRows, warnings };
  }

  private async loadOwner(): Promise<void> {
    const [o] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.nickname, this.opts.ownerNickname), eq(users.status, 'active')));
    if (o) {
      this.owner = {
        id: o.id,
        publicId: o.publicId,
        nickname: o.nickname!,
        birthDate: o.birthDate ?? '1995-01-01',
        timezone: o.timezone,
        // Акаунт власника міг з'явитися нещодавно — його ігри однаково «старші».
        createdAt: new Date(this.now.getTime() - 200 * DAY),
        city: 'Київ',
        role: o.role,
        isGm: true,
        isOwner: true,
        activity: 0,
        reliability: 1,
        quality: 4.6,
        prefersOffline: false,
        bannedAt: null,
      };
    } else {
      this.opts.log(`owner "${this.opts.ownerNickname}" not found: owner games skipped`);
    }
    // Хто «накладає» бан у демо (бан — лише адмін+): наявний адмін, інакше власник.
    const staff = await this.db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(and(inArray(users.role, ['admin', 'owner']), eq(users.status, 'active')));
    this.adminActorId =
      staff.find((s) => s.role === 'admin')?.id ??
      staff.find((s) => s.role === 'owner')?.id ??
      null;
  }

  // ---------- користувачі ----------

  private nicknameMaker(taken: Set<string>): () => string {
    const r = this.rng;
    const patterns: [() => string, number][] = [
      [() => `${r.pick(T.NAMES_LATIN)}_${r.pick(T.SURNAME_INITIALS_LATIN)}`, 8],
      [() => `${r.pick(T.NAMES_LATIN)}.${r.pick(T.SURNAMES_LATIN)}`, 6],
      [() => `${r.pick(T.NAMES_LATIN)}${r.chance(0.5) ? r.int(1985, 2006) : r.int(7, 99)}`, 7],
      [() => `${r.pick(T.NAMES_CYR)}_${r.pick(T.HANDLE_WORDS_CYR)}`, 6],
      [() => `${r.pick(T.HANDLE_WORDS_LATIN)}_${r.pick(T.HANDLE_SUFFIXES)}`, 6],
      [() => `${r.pick(T.HANDLE_WORDS_CYR)}${r.int(2, 99)}`, 4],
      [() => `${r.pick(T.NAMES_CYR)}_${r.pick(T.SURNAME_INITIALS_CYR)}`, 6],
      [() => `${r.pick(T.NAMES_LATIN)}_${r.pick(T.HANDLE_WORDS_LATIN)}`, 5],
      [() => `${capital(r.pick(T.HANDLE_WORDS_LATIN))}${capital(r.pick(T.HANDLE_WORDS_LATIN))}`, 4],
      [() => `${r.pick(T.NAMES_CYR)}.${r.pick(T.SURNAME_INITIALS_CYR)}`, 3],
      [() => capital(r.pick(T.NAMES_LATIN)), 2],
      [() => r.pick(T.HANDLE_WORDS_CYR), 2],
      [() => `${r.pick(T.NAMES_LATIN)}-${r.pick(T.HANDLE_SUFFIXES)}`, 3],
      [() => `the_${r.pick(T.HANDLE_WORDS_LATIN)}`, 2],
    ];
    return () => {
      for (let i = 0; i < 200; i++) {
        let nick = r.weighted(patterns.map(([f, w]) => [f, w] as const))();
        if (r.chance(0.12)) nick = capital(nick);
        if (!NICK_RE.test(nick) || taken.has(foldKey(nick))) continue;
        taken.add(foldKey(nick));
        return nick;
      }
      throw new Error('could not generate a unique nickname');
    };
  }

  private publicIdMaker(taken: Set<string>): () => string {
    return () => {
      for (;;) {
        let s = '';
        for (let i = 0; i < PUBLIC_ID_LENGTH; i++) s += this.rng.pick([...PUBLIC_ID_ALPHABET]);
        if (!taken.has(s)) {
          taken.add(s);
          return s;
        }
      }
    };
  }

  private birthDate(minAge: number, maxAge: number): string {
    const year =
      Number(localDate(this.now, 'Europe/Kyiv').slice(0, 4)) - this.rng.int(minAge, maxAge);
    const month = this.rng.int(1, 12);
    const day = this.rng.int(1, 28);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  ageNow(u: DUser): number {
    return ageOn(u.birthDate, localDate(this.now, u.timezone));
  }

  private async createUsers(): Promise<void> {
    const r = this.rng;
    const existing = await this.db
      .select({ nickname: users.nickname, publicId: users.publicId })
      .from(users);
    const takenNick = new Set(existing.flatMap((u) => (u.nickname ? [foldKey(u.nickname)] : [])));
    const takenPid = new Set(existing.map((u) => u.publicId));
    const nick = this.nicknameMaker(takenNick);
    const pid = this.publicIdMaker(takenPid);

    const total = this.n(120, 14);
    const gmCount = this.n(28, 4);
    const people: Omit<DUser, 'id'>[] = [];
    for (let i = 0; i < total; i++) {
      const isGm = i < gmCount;
      // Майстри — давніші акаунти; гравці — розкидані на ~6 місяців, з густішим початком.
      const ageDays = isGm ? r.float(150, 200) : 6 + 194 * Math.sqrt(r.next());
      const timezone = r.weighted(T.TIMEZONES);
      const abroad = timezone !== 'Europe/Kyiv';
      const minor = !isGm && r.chance(0.05);
      people.push({
        publicId: pid(),
        nickname: nick(),
        birthDate: minor
          ? this.birthDate(15, 17)
          : isGm
            ? this.birthDate(21, 44)
            : this.birthDate(18, 42),
        timezone,
        createdAt: at(this.now.getTime() - ageDays * DAY),
        city: abroad
          ? r.chance(0.3)
            ? r.weighted(T.CITY_WEIGHTS)
            : null
          : r.chance(0.8)
            ? r.weighted(T.CITY_WEIGHTS)
            : null,
        role: 'user',
        isGm,
        isOwner: false,
        activity: isGm
          ? r.float(0.6, 1.6)
          : r.weighted([
              [0.15, 2],
              [0.6, 4],
              [1, 4],
              [1.8, 2],
              [3, 1],
            ] as const),
        reliability: r.float(0.78, 0.99),
        quality: isGm ? Math.min(4.95, r.normal(4.2, 0.45)) : r.normal(4.3, 0.4),
        prefersOffline: r.chance(0.3),
        bannedAt: null,
      });
    }
    // Персонал і порушник — серед гравців (не майстрів), давніх акаунтів.
    const players = people
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => !p.isGm && this.ageOfBirth(p) >= 20);
    const modCount = this.scale >= 0.5 ? 2 : 1;
    for (const { p } of players.slice(0, modCount)) {
      p.role = 'moderator';
      p.createdAt = at(this.now.getTime() - r.float(170, 200) * DAY);
      p.activity = 1.2;
    }
    const bannedSlot = players[modCount];
    if (bannedSlot) {
      bannedSlot.p.bannedAt = at(this.now.getTime() - 12 * DAY - r.int(0, 8) * HOUR);
      bannedSlot.p.createdAt = at(this.now.getTime() - r.float(120, 170) * DAY);
      bannedSlot.p.activity = 1.5;
    }

    const ids: number[] = [];
    for (const part of chunk(people)) {
      const res = await this.db
        .insert(users)
        .values(
          part.map((p) => ({
            publicId: p.publicId,
            nickname: p.nickname,
            birthDate: p.birthDate,
            role: p.role,
            status: 'active' as const,
            timezone: p.timezone,
            locale: 'uk',
            // Більшість — з аваткою-твариною (зовнішнє фото за URL, без завантаження).
            avatarUrl: r.chance(0.8)
              ? `https://loremflickr.com/256/256/${r.pick(T.AVATAR_ANIMALS)}?lock=${r.int(1, 99999)}`
              : null,
            createdAt: p.createdAt,
            updatedAt: p.createdAt,
          })),
        )
        .$returningId();
      ids.push(...res.map((x) => x.id));
    }
    this.people = people.map((p, i) => ({ ...p, id: ids[i]! }));
    for (const part of chunk(ids)) {
      await this.db
        .insert(demoEntities)
        .values(part.map((entityId) => ({ entityType: 'user' as const, entityId })));
    }
    this.gms = this.people.filter((p) => p.isGm);
    this.moderators = this.people.filter((p) => p.role === 'moderator');
    this.banned = this.people.find((p) => p.bannedAt !== null) ?? null;

    await this.db.insert(authIdentities).values(
      this.people.map((p) => ({
        userId: p.id,
        provider: 'dev' as const,
        subject: p.nickname,
        displayName: DEMO_IDENTITY_MARKER,
        createdAt: p.createdAt,
      })),
    );
    // Аватар демо-користувача живе на його dev-ідентичності: `users.avatar_url` — обчислюване
    // значення (`users/avatar.ts`), яке при вході перераховується з ідентичностей.
    await this.db.execute(
      sql`UPDATE auth_identities i JOIN users u ON u.id = i.user_id
          SET i.avatar_url = u.avatar_url
          WHERE i.provider = 'dev' AND i.display_name = ${DEMO_IDENTITY_MARKER}`,
    );
    await this.insertProfiles();
    await this.insertAvailability();
  }

  private ageOfBirth(p: { birthDate: string }): number {
    return ageOn(p.birthDate, localDate(this.now, 'Europe/Kyiv'));
  }

  private async insertProfiles(): Promise<void> {
    const r = this.rng;
    const bios = new Deck(r, T.BIOS);
    const rows = this.people
      .filter(() => r.chance(0.88))
      .map((p) => {
        const favorite = r
          .sample(
            this.catalog.systems,
            r.weighted([
              [0, 2],
              [1, 4],
              [2, 4],
              [3, 2],
            ] as const),
          )
          .map((s) => s.id);
        const formats = p.prefersOffline
          ? r.chance(0.5)
            ? (['offline'] as const)
            : (['online', 'offline'] as const)
          : r.weighted([
              [['online'] as const, 6],
              [['online', 'offline'] as const, 3],
              [[] as const, 1],
            ] as const);
        const privacy: Record<string, boolean> = {};
        if (r.chance(0.1)) privacy.city = false;
        if (r.chance(0.06)) privacy.bio = false;
        if (r.chance(0.05)) privacy.experience = false;
        return {
          userId: p.id,
          bio: r.chance(0.68) ? bios.draw() : null,
          city: p.city,
          favoriteSystemIds: favorite,
          preferredFormats: [...formats],
          experience: p.isGm
            ? r.weighted([
                ['veteran', 6],
                ['intermediate', 4],
              ] as const)
            : r.weighted([
                ['none', 1],
                ['beginner', 3],
                ['intermediate', 4],
                ['veteran', 2],
                [null, 1],
              ] as const),
          privacy,
        };
      });
    for (const part of chunk(rows)) await this.db.insert(userProfiles).values(part);
  }

  private async insertAvailability(): Promise<void> {
    const r = this.rng;
    const slots: { userId: number; weekday: number; startMin: number; endMin: number }[] = [];
    const busy: { userId: number; date: string }[] = [];
    for (const p of this.people) {
      if (r.chance(0.66)) {
        const weekdays = r.sample([0, 1, 2, 3, 4], r.int(1, 4));
        const from = r.pick([17, 18, 18.5, 19, 19.5, 20]);
        const to = r.pick([22, 22.5, 23, 23.5, 24]);
        for (const wd of weekdays)
          slots.push({ userId: p.id, weekday: wd, startMin: from * 60, endMin: to * 60 });
        for (const wd of r.sample([5, 6], r.int(0, 2))) {
          const a = r.pick([10, 11, 12, 13, 14, 15]);
          slots.push({
            userId: p.id,
            weekday: wd,
            startMin: a * 60,
            endMin: Math.min(24, a + r.int(4, 10)) * 60,
          });
        }
      }
      if (r.chance(0.25)) {
        const dates = new Set<string>();
        for (let i = r.int(1, 4); i > 0; i--) {
          dates.add(localDate(new Date(this.now.getTime() + r.int(1, 30) * DAY), p.timezone));
        }
        for (const date of dates) busy.push({ userId: p.id, date });
      }
    }
    for (const part of chunk(slots)) await this.db.insert(availabilitySlots).values(part);
    for (const part of chunk(busy)) await this.db.insert(availabilityBusyDates).values(part);
  }

  // ---------- ігри: план ----------

  private planGames(): void {
    const r = this.rng;
    const demoTotal = this.n(75, 8);
    const gms = this.gms;
    const counts = new Map<DUser, number>(gms.map((g) => [g, 0]));
    const statusOf = (): GameStatus =>
      r.weighted([
        ['recruiting', 46],
        ['started', 18],
        ['finished', 22],
        ['cancelled', 8],
        ['draft', 8],
      ] as const);
    const plans: { gm: DUser; status: GameStatus; special: Special; overlapWith?: number }[] = [];

    // Особливі: «мертві» (двоє — в одного майстра), «застарілі», пари з накладанням сесій.
    const deadCount = this.n(4, 1);
    for (let i = 0; i < deadCount; i++) {
      const gm = i < 2 ? gms[1]! : gms[(4 + i) % gms.length]!;
      plans.push({ gm, status: r.chance(0.5) ? 'recruiting' : 'started', special: 'dead' });
    }
    for (let i = 0; i < this.n(3, 1); i++) {
      plans.push({ gm: gms[(8 + i) % gms.length]!, status: 'started', special: 'stale' });
    }
    const overlapGms = this.scale >= 0.5 ? [gms[2]!, gms[3]!] : [gms[2 % gms.length]!];
    overlapGms.forEach((gm, i) => {
      plans.push({ gm, status: 'started', special: 'overlap', overlapWith: i });
      plans.push({ gm, status: 'started', special: 'overlap', overlapWith: i });
    });
    for (const p of plans) counts.set(p.gm, counts.get(p.gm)! + 1);
    // Зайнятий майстер (gms[0]) — ~10% ігор; кожен інший — хоча б одна.
    const busy = Math.max(3, Math.round(demoTotal * 0.1));
    for (let i = 0; i < busy; i++) plans.push({ gm: gms[0]!, status: statusOf(), special: null });
    for (const gm of gms.slice(1)) {
      if (counts.get(gm)! === 0 && plans.length < demoTotal)
        plans.push({ gm, status: statusOf(), special: null });
    }
    const weights = gms.slice(1).map((g) => [g, g.activity] as const);
    while (plans.length < demoTotal)
      plans.push({ gm: r.weighted(weights), status: statusOf(), special: null });

    // Власник: ~50 ігор у змішаних статусах.
    if (this.owner) {
      const total = this.n(50, 6);
      const mix: [GameStatus, number][] = [
        ['recruiting', 0.3],
        ['started', 0.24],
        ['finished', 0.28],
        ['cancelled', 0.08],
        ['draft', 0.1],
      ];
      const statuses: GameStatus[] = [];
      for (const [s, share] of mix)
        for (let i = 0; i < Math.max(1, Math.round(total * share)); i++) statuses.push(s);
      for (const s of r.shuffle(statuses).slice(0, total))
        plans.push({ gm: this.owner, status: s, special: null });
    }

    const systemDeck = new Deck(r, this.catalog.systems);
    const otherDeck = new Deck(r, T.OTHER_SYSTEMS);
    const genreDeck = new Deck(r, this.catalog.genres);
    const titleDecks = new Map<string, Deck<string>>();
    const overlapSlot = new Map<number, { startsAt: Date; duration: number }>();
    const running = new Map<number, DGame[]>();

    for (const p of plans) {
      const g = this.makeGame(p.gm, p.status, p.special, {
        systemDeck,
        otherDeck,
        genreDeck,
        titleDecks,
      });
      if (p.special === 'overlap') {
        // Друга гра пари — той самий день тижня й час (інша дата першої сесії).
        const prev = overlapSlot.get(p.overlapWith!);
        if (prev) {
          // Обидві мають ≥ 3 сесії за останні 4 тижні (правило `overlapRule`).
          const room = this.now.getTime() - 29 * DAY - prev.startsAt.getTime();
          const shift = r.int(0, Math.max(0, Math.floor(room / (7 * DAY)))) * 7 * DAY;
          const s = prev.startsAt.getTime() + shift;
          g.startsAt = new Date(s);
          g.durationMinutes = prev.duration;
          g.weekdays = [toZoned(g.startsAt, g.timezone).weekday];
          g.publishedAt = at(s - r.float(4, 12) * DAY);
          g.createdAt = at(g.publishedAt.getTime() - r.float(0.1, 3) * DAY);
          g.startedAt = at(s - r.float(0.2, 1.5) * DAY);
        } else {
          overlapSlot.set(p.overlapWith!, { startsAt: g.startsAt, duration: g.durationMinutes });
        }
      } else if (g.kind === 'campaign' && (g.status === 'started' || g.status === 'recruiting')) {
        this.avoidOverlap(g, running.get(g.gm.id) ?? []);
      }
      if (g.kind === 'campaign' && (g.status === 'started' || g.status === 'recruiting')) {
        running.set(g.gm.id, [...(running.get(g.gm.id) ?? []), g]);
      }
      this.validate(g);
      this.plans.push(g);
    }
  }

  /** Те саме правило, що й форма гри (`gameInputSchema`): інакше демо-гра не відкриється на редагування. */
  private validate(g: DGame): void {
    gameInputSchema(g.timezone).parse({
      title: g.title,
      description: g.description,
      systemId: g.systemId,
      systemOther: g.systemOther,
      genreId: g.genreId,
      format: g.format,
      city: g.city,
      address: g.address,
      platform: g.platform,
      kind: g.kind,
      startsAt: g.startsAt.toISOString(),
      durationMinutes: g.durationMinutes,
      recurrence: g.recurrence,
      weekdays: g.weekdays,
      minPlayers: g.minPlayers,
      maxPlayers: g.maxPlayers,
      priceUah: g.priceUah,
      ageRating: g.ageRating,
      experience: g.experience,
      language: g.language,
      requirements: g.requirements,
      coverUrl: g.coverUrl,
      // Канали — http(s)-посилання на сторінку 404 застосунку (у dev PUBLIC_BASE_URL — http,
      // схема гри приймає лише https), тож у валідацію не йдуть і пишуться напряму.
      channelLinks: [],
      applicationQuestions: g.applicationQuestions,
      customWarnings: g.customWarnings,
      contentWarningIds: g.contentWarningIds,
      showWhenFull: g.showWhenFull,
    });
  }

  /** Локальний час `hh:mm` дня, у який потрапляє `base`, у поясі `tz`. */
  private localAt(base: number, tz: string, hhmm: string): Date {
    const z = toZoned(new Date(base), tz);
    const [h, m] = hhmm.split(':').map(Number) as [number, number];
    return zonedToUtc({ year: z.year, month: z.month, day: z.day, hour: h, minute: m }, tz);
  }

  private startTime(base: number, tz: string): Date {
    const wd = toZoned(new Date(base), tz).weekday;
    const t =
      wd >= 5
        ? this.rng.pick(['11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'])
        : this.rng.pick(['17:30', '18:00', '18:30', '19:00', '19:00', '19:30', '20:00', '20:30']);
    return this.localAt(base, tz, t);
  }

  /** Кампанії одного майстра, що йдуть, не перетинаються за днем і часом (інакше — «підозріла»). */
  private avoidOverlap(g: DGame, others: DGame[]): void {
    const clash = (a: DGame, b: DGame) => {
      const za = toZoned(a.startsAt, a.timezone);
      const zb = toZoned(b.startsAt, b.timezone);
      const da = a.weekdays.length ? a.weekdays : [za.weekday];
      const dbs = b.weekdays.length ? b.weekdays : [zb.weekday];
      if (!da.some((d) => dbs.includes(d))) return false;
      const sa = za.hour * 60 + za.minute;
      const sb = zb.hour * 60 + zb.minute;
      return sa < sb + b.durationMinutes && sb < sa + a.durationMinutes;
    };
    const orig = g.startsAt.getTime();
    for (let i = 0; i < 40 && others.some((o) => clash(g, o)); i++) {
      const base = orig + this.rng.int(-3, 3) * DAY;
      const hh = this.rng.pick([
        '10:00',
        '11:00',
        '13:00',
        '14:00',
        '16:00',
        '17:00',
        '19:00',
        '20:00',
        '21:00',
      ]);
      let s = this.localAt(base, g.timezone, hh);
      if (g.publishedAt && s.getTime() <= g.publishedAt.getTime() + HOUR)
        s = new Date(s.getTime() + 7 * DAY);
      g.startsAt = s;
      if (g.recurrence === 'weekly' || g.recurrence === 'biweekly')
        g.weekdays = [toZoned(s, g.timezone).weekday];
      if (i > 20) g.durationMinutes = 150;
    }
  }

  private makeGame(
    gm: DUser,
    status: GameStatus,
    special: Special,
    decks: {
      systemDeck: Deck<Catalog['systems'][number]>;
      otherDeck: Deck<(typeof T.OTHER_SYSTEMS)[number]>;
      genreDeck: Deck<Catalog['genres'][number]>;
      titleDecks: Map<string, Deck<string>>;
    },
  ): DGame {
    const r = this.rng;
    const now = this.now.getTime();
    const tz = gm.timezone;
    const genreBySlug = new Map(this.catalog.genres.map((g) => [g.slug, g]));

    // Система, жанр, назва.
    let systemId: number | null = null;
    let systemOther: string | null = null;
    let genre: Catalog['genres'][number];
    let flavor: T.SystemFlavor;
    let flavorKey: string;
    if (r.chance(0.12) && special === null) {
      const o = decks.otherDeck.draw();
      systemOther = o.name;
      genre = genreBySlug.get(o.genre) ?? this.catalog.genres[0]!;
      flavor = { titles: o.titles, hooks: o.hooks, praise: ['атмосферу', 'сюжет'] };
      flavorKey = `other:${o.name}`;
    } else {
      const s = decks.systemDeck.draw();
      systemId = s.id;
      flavor = T.SYSTEM_FLAVOR[s.slug] ?? T.GENERIC_FLAVOR;
      flavorKey = s.slug;
      // Жанр за замовчуванням або правдоподібний для системи (CoC — не «фентезі»).
      const fitting = (T.SYSTEM_GENRES[s.slug] ?? [])
        .map((slug) => genreBySlug.get(slug))
        .filter((x): x is Catalog['genres'][number] => x !== undefined);
      const byDefault = this.catalog.genres.find((x) => x.id === s.defaultGenreId);
      genre =
        byDefault && (fitting.length === 0 || r.chance(0.55))
          ? byDefault
          : fitting.length
            ? r.pick(fitting)
            : decks.genreDeck.draw();
    }
    let deck = decks.titleDecks.get(flavorKey);
    if (!deck) {
      deck = new Deck(r, flavor.titles);
      decks.titleDecks.set(flavorKey, deck);
    }
    // Без повторів назв: спершу інші назви пулу, далі — варіанти («новий набір» тощо).
    let title = deck.draw();
    for (let i = 0; i < flavor.titles.length && this.usedTitles.has(title); i++)
      title = deck.draw();
    if (this.usedTitles.has(title)) {
      const base = title;
      const variants = r.shuffle([
        ' (новий набір)',
        ': друга група',
        ' II',
        ' — вечірня група',
        ': повернення',
        ' (ваншот-пролог)',
        ': нова глава',
      ]);
      title =
        variants.map((v) => `${base}${v}`).find((t) => !this.usedTitles.has(t)) ??
        `${base} — набір ${this.usedTitles.size}`;
    }
    this.usedTitles.add(title);

    const kind: GameKind = special !== null ? 'campaign' : r.chance(0.38) ? 'oneshot' : 'campaign';
    const format: GameFormat =
      special === 'overlap' || gm.timezone !== 'Europe/Kyiv' || !r.chance(0.4)
        ? 'online'
        : 'offline';
    const city =
      format === 'offline'
        ? gm.city && r.chance(0.7)
          ? gm.city
          : r.weighted(T.CITY_WEIGHTS)
        : null;
    const address =
      format === 'offline' && r.chance(0.75) ? r.pick(T.VENUES[city!] ?? T.GENERIC_VENUES) : null;
    const platform = format === 'online' ? r.weighted(T.PLATFORMS) : null;
    const language: GameLanguage = r.chance(0.1) ? 'en' : 'uk';
    const experience = r.weighted([
      ['any', 50],
      ['beginner', 25],
      ['experienced', 25],
    ] as const);
    const dark = ['horror', 'dark-fantasy', 'noir'].includes(genre.slug);
    let ageRating: AgeRating = r.weighted([
      ['none', dark ? 56 : 80],
      ['16+', dark ? 16 : 10],
      ['18+', dark ? 22 : 8],
      ['21+', dark ? 6 : 2],
    ] as const);
    if (ageRating === '21+' && this.ageNow(gm) < 21) ageRating = '18+';
    const paid = r.chance(format === 'offline' ? 0.55 : 0.35);
    const priceUah = paid
      ? r.weighted([
          [100, 3],
          [150, 5],
          [200, 6],
          [250, 4],
          [300, 3],
          [350, 2],
          [400, 2],
          [500, 1],
        ] as const)
      : null;
    const durationMinutes =
      kind === 'oneshot'
        ? r.pick([180, 210, 240, 240, 240, 270, 300, 360])
        : r.pick([150, 180, 180, 210, 240]);
    let maxPlayers: number = r.weighted(
      kind === 'oneshot'
        ? ([
            [3, 15],
            [4, 35],
            [5, 30],
            [6, 15],
            [7, 5],
          ] as const)
        : ([
            [3, 10],
            [4, 35],
            [5, 35],
            [6, 15],
            [7, 5],
          ] as const),
    );
    if (format === 'offline' && r.chance(0.3)) maxPlayers = Math.min(8, maxPlayers + 1);
    const minPlayers = Math.min(
      maxPlayers,
      r.weighted([
        [1, 1],
        [2, 5],
        [3, 4],
      ] as const),
    );
    const recurrence: Recurrence =
      kind === 'oneshot'
        ? 'none'
        : special !== null
          ? 'weekly'
          : r.weighted([
              ['weekly', 55],
              ['biweekly', 25],
              ['monthly', 12],
              ['none', 8],
            ] as const);

    // Хронологія: створення → публікація → (старт) → перша сесія → завершення/скасування.
    let S: Date;
    let C: number;
    let P: number | null;
    let startedAt: number | null = null;
    let finishedAt: number | null = null;
    let cancelledAt: number | null = null;
    let played = 0;
    let lastDoneAt: Date | null = null;
    const back = (days: number) => now - days * DAY;
    const fwd = (days: number) => now + days * DAY;
    switch (status) {
      case 'draft':
        C = back(r.float(0.2, 20));
        S = this.startTime(fwd(r.int(7, 50)), tz);
        P = null;
        break;
      case 'recruiting':
        if (special === 'dead') {
          P = back(r.float(125, 170));
          S = this.startTime(P + r.int(3, 10) * DAY, tz);
        } else if (kind === 'campaign' && r.chance(0.2)) {
          S = this.startTime(back(r.int(7, 40)), tz);
          P = S.getTime() - r.float(3, 14) * DAY;
        } else {
          S = this.startTime(fwd(r.int(1, 56)), tz);
          P = Math.min(back(r.float(0.1, 25)), S.getTime() - 6 * HOUR);
        }
        C = P - r.float(0.05, 4) * DAY;
        break;
      case 'started':
        if (special === 'dead') {
          P = back(r.float(125, 170));
          S = this.startTime(P + r.int(3, 10) * DAY, tz);
        } else if (special === 'stale') {
          S = this.startTime(back(r.int(100, 150)), tz);
          P = S.getTime() - 7 * DAY;
          lastDoneAt = new Date(back(r.float(36, 75)));
        } else if (special === 'overlap') {
          S = this.startTime(back(r.int(40, 90)), tz);
          P = S.getTime() - r.float(4, 12) * DAY;
        } else if (kind === 'oneshot') {
          S = this.startTime(fwd(r.int(1, 12)), tz);
          P = back(r.float(5, 25));
        } else {
          S = this.startTime(back(r.int(10, 120)), tz);
          P = S.getTime() - r.float(4, 20) * DAY;
        }
        C = P - r.float(0.05, 3) * DAY;
        startedAt =
          kind === 'oneshot' && S.getTime() > now
            ? back(r.float(0.5, 4))
            : Math.max(P + HOUR, S.getTime() - r.float(0, 2) * DAY);
        break;
      case 'finished':
        if (kind === 'campaign') {
          S = this.startTime(back(r.int(70, 180)), tz);
        } else {
          S = this.startTime(r.chance(0.4) ? back(r.int(2, 25)) : back(r.int(26, 170)), tz);
        }
        P = S.getTime() - r.float(5, 25) * DAY;
        C = P - r.float(0.05, 4) * DAY;
        startedAt = Math.max(P + HOUR, S.getTime() - r.float(0.2, 3) * DAY);
        break;
      case 'cancelled':
        if (kind === 'campaign' && r.chance(0.45)) {
          S = this.startTime(back(r.int(40, 150)), tz);
          P = S.getTime() - r.float(5, 15) * DAY;
          startedAt = S.getTime() - r.float(0.2, 1.5) * DAY;
          cancelledAt = Math.min(back(1), S.getTime() + r.int(14, 50) * DAY);
        } else {
          P = back(r.float(10, 150));
          S = this.startTime(P + r.int(5, 30) * DAY, tz);
          cancelledAt = Math.min(
            back(0.5),
            P + r.float(0.5, Math.max(1, (S.getTime() - P) / DAY - 0.5)) * DAY,
          );
        }
        C = P - r.float(0.05, 4) * DAY;
        break;
      case 'paused':
        // Демо-набір не планує кампейнів на паузі.
        throw new Error('demo seed: paused games are not planned');
    }
    // Не раніше за акаунт майстра (крім власника — див. loadOwner).
    if (C < gm.createdAt.getTime() + HOUR) C = gm.createdAt.getTime() + HOUR;
    if (P !== null && P <= C) P = C + r.float(0.1, 2) * DAY;
    if (P !== null && S.getTime() <= P) S = this.startTime(P + r.int(2, 6) * DAY, tz);

    const weekdays: Weekday[] = [];
    if (recurrence === 'weekly' || recurrence === 'biweekly') {
      const wd = toZoned(S, tz).weekday;
      weekdays.push(wd);
      if (recurrence === 'weekly' && special === null && gm.isOwner === false && r.chance(0.12)) {
        const extra = ((wd + r.pick([2, 3])) % 7) as Weekday;
        weekdays.push(extra);
        weekdays.sort((a, b) => a - b);
      }
    }

    // Завершена кампанія: k зіграних слотів, завершення — після останнього.
    if (status === 'finished') {
      if (kind === 'campaign') {
        const slots = expandOccurrences(
          { startsAt: S.toISOString(), durationMinutes, recurrence, weekdays, timezone: tz },
          new Date(S.getTime() - MIN),
          new Date(now - 2 * DAY),
        );
        played = Math.max(1, Math.min(slots.length, r.int(4, 14)));
        const last = slots[played - 1] ?? { start: S };
        finishedAt = Math.min(
          back(0.1),
          last.start.getTime() + durationMinutes * MIN + r.float(1, 48) * HOUR,
        );
      } else {
        played = 1;
        finishedAt = Math.min(
          back(0.05),
          S.getTime() + durationMinutes * MIN + r.float(0.3, 30) * HOUR,
        );
      }
    }

    const description = this.describe(flavor, kind, format, language);
    const questions = r.chance(0.45) ? r.sample(T.APPLICATION_QUESTIONS, r.int(1, 3)) : [];
    const cw = this.catalog.warnings;
    const warningIds =
      cw.length && r.chance(dark ? 0.7 : 0.25)
        ? r
            .sample(cw, r.int(1, Math.min(4, cw.length)))
            .map((w) => w.id)
            .sort((a, b) => a - b)
        : [];
    const end = finishedAt ?? cancelledAt ?? now;
    return {
      id: 0,
      gm,
      isOwnerGame: gm.isOwner,
      special,
      title,
      description,
      systemId,
      systemOther,
      genreId: genre.id,
      genreSlug: genre.slug,
      praise: flavor.praise,
      format,
      city,
      address,
      platform,
      kind,
      startsAt: S,
      durationMinutes,
      recurrence,
      weekdays,
      timezone: tz,
      minPlayers,
      maxPlayers,
      priceUah,
      ageRating,
      experience,
      language,
      requirements: r.chance(0.4) ? r.sample(T.REQUIREMENTS, r.int(1, 2)).join(' ') : null,
      applicationQuestions: questions,
      customWarnings: r.chance(dark ? 0.3 : 0.08) ? r.sample(T.CUSTOM_WARNINGS, r.int(1, 2)) : [],
      contentWarningIds: warningIds,
      showWhenFull: r.chance(0.35),
      coverUrl: r.chance(0.65)
        ? `https://picsum.photos/seed/nri-demo-${r.int(1, 999999)}/800/450`
        : null,
      channelLinks:
        status === 'draft' || !r.chance(0.7)
          ? []
          : r.sample(T.CHANNEL_KINDS, r.int(1, 2)).map((c) => ({
              label: c.label,
              url: `${this.opts.publicBaseUrl}/demo/${c.slug}/${r.int(1000, 9999)}`,
            })),
      status,
      createdAt: at(C),
      publishedAt: P === null ? null : at(P),
      startedAt: startedAt === null ? null : at(startedAt),
      finishedAt: finishedAt === null ? null : at(finishedAt),
      cancelledAt: cancelledAt === null ? null : at(cancelledAt),
      endAt: at(end),
      played,
      lastDoneAt,
      sessions: [],
      apps: [],
      members: [],
    };
  }

  /** Опис різної довжини й тону: від одного речення до кількох абзаців. */
  private describe(
    f: T.SystemFlavor,
    kind: GameKind,
    format: GameFormat,
    language: GameLanguage,
  ): string {
    const r = this.rng;
    const hook = r.pick(f.hooks);
    const size = r.weighted([
      ['terse', 2],
      ['short', 4],
      ['medium', 4],
      ['long', 2],
    ] as const);
    const parts: string[] = [];
    if (size !== 'terse' && r.chance(0.4)) parts.push(r.pick(T.OPENERS));
    parts.push(hook);
    const detailPool = kind === 'campaign' ? T.DETAILS_CAMPAIGN : T.DETAILS_ONESHOT;
    const logistics = format === 'online' ? T.DETAILS_ONLINE : T.DETAILS_OFFLINE;
    if (size === 'terse') {
      if (r.chance(0.5)) parts.push(r.pick(logistics));
      return this.withLanguage(parts.join(' '), language);
    }
    const paragraphs = [parts.join(' ')];
    if (size === 'short') {
      paragraphs[0] += ` ${r.pick(detailPool)}`;
      if (r.chance(0.5)) paragraphs.push(r.pick(T.CLOSERS));
    } else {
      paragraphs.push(r.sample(detailPool, size === 'long' ? 3 : 2).join(' '));
      paragraphs.push(r.sample(logistics, size === 'long' ? 2 : 1).join(' '));
      if (size === 'long' || r.chance(0.5))
        paragraphs.push(r.sample(T.DETAILS_TONE, size === 'long' ? 2 : 1).join(' '));
      if (r.chance(0.6)) paragraphs.push(r.pick(T.CLOSERS));
    }
    return this.withLanguage(paragraphs.join('\n\n'), language);
  }

  private withLanguage(text: string, language: GameLanguage): string {
    if (language === 'uk') return text;
    return `${text}\n\nГра англійською: за столом говоримо English, рівень B1+ буде достатньо.`;
  }

  // ---------- сесії, заявки, члени ----------

  private planPeopleInGames(): void {
    for (const g of this.plans) {
      if (g.status === 'draft') continue;
      this.planSessions(g);
      this.planMembers(g);
      this.planOtherApplications(g);
      this.planAttendance(g);
    }
  }

  private planSessions(g: DGame): void {
    const r = this.rng;
    const now = this.now.getTime();
    const rule = {
      startsAt: g.startsAt.toISOString(),
      durationMinutes: g.durationMinutes,
      recurrence: g.recurrence,
      weekdays: g.weekdays,
      timezone: g.timezone,
    };
    const from = new Date(g.startsAt.getTime() - MIN);
    let to: number;
    if (g.kind === 'oneshot' || g.recurrence === 'none') to = g.startsAt.getTime() + MIN;
    else if (g.special === 'dead') to = g.publishedAt!.getTime() + SESSION_WINDOW_DAYS * DAY;
    else if (g.status === 'finished' || g.status === 'cancelled')
      to = g.endAt.getTime() + SESSION_WINDOW_DAYS * DAY;
    else to = now + SESSION_WINDOW_DAYS * DAY;
    const slots = expandOccurrences(rule, from, new Date(to));
    const ended = g.status === 'finished' || g.status === 'cancelled';
    const endReason = g.status === 'finished' ? 'game_finished' : 'game_cancelled';
    slots.forEach((slot, i) => {
      const ruleStart = slot.start;
      let startsAt = ruleStart;
      let rescheduled = false;
      if (r.chance(0.05) && g.kind === 'campaign') {
        startsAt = new Date(ruleStart.getTime() + r.pick([DAY, -HOUR, 30 * MIN, 2 * HOUR]));
        rescheduled = true;
      }
      const endMs = startsAt.getTime() + g.durationMinutes * MIN;
      let status: DSession['status'] = 'scheduled';
      let cancelReason: string | null = null;
      let cancelledAt: Date | null = null;
      if (
        ended &&
        (g.status === 'finished' ? i >= g.played : startsAt.getTime() > g.endAt.getTime())
      ) {
        // Майбутні сесії завершеної/скасованої гри скасовуються автоматично.
        if (startsAt.getTime() <= g.endAt.getTime()) return;
        status = 'cancelled';
        cancelReason = endReason;
      } else if (endMs < now) {
        const cancelP =
          g.special === 'dead'
            ? 0.3
            : g.special === 'stale' && g.lastDoneAt && startsAt > g.lastDoneAt
              ? 0.6
              : 0.08;
        const unmarked =
          g.special === 'dead' ||
          (g.special === 'stale' && g.lastDoneAt !== null && startsAt > g.lastDoneAt) ||
          (!ended && !g.isOwnerGame && g.special === null && r.chance(0.04));
        if (i > 0 && r.chance(cancelP)) {
          status = 'cancelled';
          cancelReason = r.pick(T.SESSION_CANCEL_REASONS);
          cancelledAt = at(
            Math.max(
              startsAt.getTime() - r.float(2, 48) * HOUR,
              (g.publishedAt ?? g.createdAt).getTime() + MIN,
            ),
          );
        } else if (!unmarked) {
          status = 'done';
        }
      }
      const doneAt =
        status === 'done' ? at(Math.min(now - MIN, endMs + r.float(5 / 60, 20) * HOUR)) : null;
      g.sessions.push({
        id: 0,
        startsAt,
        ruleStartsAt: ruleStart,
        durationMinutes: g.durationMinutes,
        status,
        origin: 'rule',
        rescheduled,
        cancelReason,
        cancelledAt,
        summary: status === 'done' && r.chance(0.45) ? r.pick(T.SESSION_SUMMARIES) : null,
        doneAt,
        createdAt: at(
          Math.min(
            now,
            Math.max(
              (g.publishedAt ?? g.createdAt).getTime(),
              ruleStart.getTime() - SESSION_WINDOW_DAYS * DAY,
            ),
          ),
        ),
        present: [],
        hasAttendance: true,
      });
    });
    // Іноді майстер додає позапланову сесію (без правила) у майбутньому.
    if (!ended && g.kind === 'campaign' && g.special === null && r.chance(0.1)) {
      const s = this.startTime(now + r.int(3, 20) * DAY, g.timezone);
      g.sessions.push({
        id: 0,
        startsAt: s,
        ruleStartsAt: null,
        durationMinutes: g.durationMinutes,
        status: 'scheduled',
        origin: 'manual',
        rescheduled: false,
        cancelReason: null,
        cancelledAt: null,
        summary: null,
        doneAt: null,
        createdAt: at(now - r.float(0.5, 5) * DAY),
        present: [],
        hasAttendance: true,
      });
    }
  }

  private eligible(g: DGame, u: DUser, when: number): boolean {
    if (u.id === g.gm.id || u.createdAt.getTime() >= when - HOUR) return false;
    if (u.bannedAt && u.bannedAt.getTime() < when) return false;
    return meetsAgeRating(ageOn(u.birthDate, localDate(new Date(when), u.timezone)), g.ageRating);
  }

  private weightFor(g: DGame, u: DUser): number {
    let w = u.activity;
    if (g.format === 'offline') w *= u.city === g.city ? 6 : 0.15;
    else if (u.prefersOffline) w *= 0.4;
    if (u.role === 'moderator') w *= 0.7;
    return w;
  }

  private pickUsers(g: DGame, n: number, when: number, exclude: Set<number>): DUser[] {
    const out: DUser[] = [];
    let pool = this.people.filter((u) => !exclude.has(u.id) && this.eligible(g, u, when));
    for (let i = 0; i < n && pool.length; i++) {
      const u = this.rng.weighted(pool.map((p) => [p, this.weightFor(g, p)] as const));
      out.push(u);
      pool = pool.filter((p) => p.id !== u.id);
    }
    return out;
  }

  private newApp(g: DGame, u: DUser, createdAt: number, status: DApp['status']): DApp {
    const r = this.rng;
    const constraints = r.chance(0.2)
      ? [{ id: this.constraintId(), text: r.pick(T.CONSTRAINTS) }]
      : [];
    return {
      key: ++this.appKey,
      id: 0,
      userId: u.id,
      status,
      cancelReason: null,
      createdAt: at(createdAt),
      decidedAt: null,
      decidedBy: null,
      message: r.chance(0.7) ? r.pick(T.APP_MESSAGES) : null,
      answers: g.applicationQuestions.map(() => r.pick(T.ANSWERS.default!)),
      constraints,
      responses: [],
    };
  }

  private constraintId(): string {
    const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let s = '';
    for (let i = 0; i < 8; i++) s += abc[this.rng.int(0, abc.length - 1)];
    return s;
  }

  private respond(app: DApp, p: number): void {
    for (const c of app.constraints) {
      if (!this.rng.chance(p)) continue;
      app.responses.push({
        constraintId: c.id,
        response: this.rng.weighted([
          ['accepted', 6],
          ['partial', 3],
          ['cannot_guarantee', 1],
        ] as const),
        comment: this.rng.chance(0.6) ? this.rng.pick(T.CONSTRAINT_REPLIES) : null,
      });
    }
  }

  private planMembers(g: DGame): void {
    const r = this.rng;
    const now = this.now.getTime();
    const P = g.publishedAt!.getTime();
    const S = g.startsAt.getTime();
    let target: number;
    switch (g.status) {
      case 'recruiting':
        target =
          g.special === 'dead'
            ? r.int(1, g.minPlayers)
            : r.chance(0.25)
              ? g.maxPlayers
              : r.int(0, g.maxPlayers - 1);
        if (S < now) target = Math.max(target, g.minPlayers);
        break;
      case 'started':
        target =
          g.special === 'dead'
            ? r.int(1, g.minPlayers)
            : r.chance(0.3)
              ? g.maxPlayers
              : r.int(g.minPlayers, g.maxPlayers);
        break;
      case 'finished':
        target = r.int(Math.max(2, g.minPlayers), g.maxPlayers);
        break;
      default:
        target = g.startedAt ? r.int(g.minPlayers, g.maxPlayers) : r.int(0, g.minPlayers);
    }
    // Вступ: до першої сесії (або протягом гри, якщо вона вже йде), не пізніше «зараз».
    const joinEnd = Math.min(
      now - HOUR,
      g.endAt.getTime() - HOUR,
      S > now ? now - HOUR : S + (g.kind === 'campaign' ? 30 * DAY : -HOUR),
    );
    const joinStart = P + HOUR;
    const chosen = this.pickUsers(
      g,
      target,
      Math.max(joinStart + HOUR, Math.min(joinEnd, S)),
      new Set(),
    );
    for (const u of chosen) {
      const lo = Math.max(joinStart, u.createdAt.getTime() + HOUR);
      const late = g.kind === 'campaign' && S < now && r.chance(0.2);
      const hi = late ? joinEnd : Math.min(joinEnd, S - HOUR);
      if (hi <= lo) continue;
      const joinedAt = r.float(lo, hi);
      const app = this.newApp(
        g,
        u,
        Math.max(lo - 30 * MIN, joinedAt - r.float(1, 96) * HOUR),
        'approved',
      );
      app.decidedAt = at(joinedAt);
      app.decidedBy = g.gm.id;
      this.respond(app, 0.7);
      g.apps.push(app);
      const member: DMember = {
        id: 0,
        userId: u.id,
        applicationKey: app.key,
        joinedAt: at(joinedAt),
        leftAt: null,
        leftReason: null,
        leaveNoteGm: null,
      };
      // Хтось виходить або його виключають посеред кампанії.
      const lifeEnd = Math.min(now - HOUR, g.endAt.getTime() - HOUR);
      if (g.kind === 'campaign' && g.startedAt && r.chance(0.15) && lifeEnd - joinedAt > 10 * DAY) {
        member.leftAt = at(r.float(joinedAt + 7 * DAY, lifeEnd));
        member.leftReason = r.weighted([
          ['left', 65],
          ['kicked', 25],
          ['banned', 15],
        ] as const);
        if (member.leftReason === 'left' && r.chance(0.4)) {
          member.leaveNoteGm = r.pick([
            'Не встигаю через роботу, вибачте.',
            'Переїжджаю, зв’язок буде поганий.',
            'Не мій жанр, але дякую за гру!',
            'Сесії надто пізно для мене.',
          ]);
        }
      }
      g.members.push(member);
    }
  }

  private planOtherApplications(g: DGame): void {
    const r = this.rng;
    const now = this.now.getTime();
    const P = g.publishedAt!.getTime();
    const end = g.endAt.getTime();
    const taken = new Set(g.apps.map((a) => a.userId));
    const running = g.status === 'recruiting' || g.status === 'started';
    // Відхилені й відкликані.
    const closedCount = r.weighted([
      [0, 4],
      [1, 4],
      [2, 2],
    ] as const);
    for (const u of this.pickUsers(g, closedCount, Math.min(end, now) - HOUR, taken)) {
      const lo = Math.max(P + HOUR, u.createdAt.getTime() + HOUR);
      const hi = Math.min(now, end) - 2 * HOUR;
      if (hi <= lo) continue;
      const created = r.float(lo, hi);
      const status = r.chance(0.75) ? 'rejected' : 'withdrawn';
      const app = this.newApp(g, u, created, status);
      app.decidedAt = at(Math.min(now - MIN, created + r.float(1, 72) * HOUR));
      if (status === 'rejected') {
        app.decidedBy = g.gm.id;
        this.respond(app, 0.5);
      }
      g.apps.push(app);
      taken.add(u.id);
    }
    // Очікують рішення (у завершених/скасованих — скасовані разом із грою).
    let pending =
      g.status === 'recruiting'
        ? g.isOwnerGame
          ? r.int(1, 4)
          : r.weighted([
              [0, 3],
              [1, 4],
              [2, 3],
              [3, 1],
            ] as const)
        : g.status === 'started'
          ? r.weighted([
              [0, 3],
              [1, 1],
            ] as const)
          : r.weighted([
              [0, 3],
              [1, 1],
            ] as const);
    if (g.special === 'dead') pending = 0;
    for (const u of this.pickUsers(g, pending, Math.min(end, now) - HOUR, taken)) {
      const lo = Math.max(P + HOUR, u.createdAt.getTime() + HOUR, running ? now - 9 * DAY : P);
      const hi = running ? now - 10 * MIN : end - HOUR;
      if (hi <= lo) continue;
      const app = this.newApp(g, u, r.float(lo, hi), running ? 'pending' : 'cancelled');
      if (!running) {
        app.cancelReason = g.status === 'finished' ? 'game_finished' : 'game_cancelled';
        app.decidedAt = at(end);
      } else {
        this.respond(app, 0.4);
      }
      g.apps.push(app);
      taken.add(u.id);
    }
  }

  private memberAt(g: DGame, m: DMember, start: number, doneAt: number): boolean {
    return m.joinedAt.getTime() <= start && (m.leftAt === null || m.leftAt.getTime() > doneAt);
  }

  private planAttendance(g: DGame): void {
    const r = this.rng;
    const noRows = g.kind === 'oneshot' && r.chance(0.25);
    for (const s of g.sessions) {
      if (s.status !== 'done') continue;
      const here = g.members.filter((m) =>
        this.memberAt(g, m, s.startsAt.getTime(), s.doneAt!.getTime()),
      );
      if (noRows) {
        // «Завершити гру» без відмітки: присутні — усі, хто був учасником.
        s.hasAttendance = false;
        s.present = here.map((m) => m.userId);
        continue;
      }
      s.present = here
        .filter((m) => r.chance(this.people.find((p) => p.id === m.userId)!.reliability))
        .map((m) => m.userId);
      (s as DSession & { absent?: number[] }).absent = here
        .map((m) => m.userId)
        .filter((id) => !s.present.includes(id));
    }
  }

  /** Бан адміністрацією: вихід з активних ігор і скасування заявок (як `runLeaveCascade`). */
  private applyBanCascade(): void {
    const b = this.banned;
    if (!b?.bannedAt) return;
    const banAt = b.bannedAt.getTime();
    for (const g of this.plans) {
      // Гра була активною в момент бану (а не зараз): створена до бану й не закінчена до нього.
      const endedBefore = [g.finishedAt, g.cancelledAt].some(
        (d) => d !== null && d.getTime() <= banAt,
      );
      const activeAtBan = g.createdAt.getTime() <= banAt && !endedBefore;
      g.members = g.members.filter((m) => m.userId !== b.id || m.joinedAt.getTime() < banAt);
      for (const m of g.members) {
        if (m.userId !== b.id || m.leftAt) continue;
        if (activeAtBan) {
          m.leftAt = at(banAt);
          m.leftReason = 'banned_by_admin';
        }
      }
      g.apps = g.apps.filter(
        (a) =>
          a.userId !== b.id ||
          a.createdAt.getTime() < banAt ||
          g.members.some((m) => m.applicationKey === a.key),
      );
      for (const a of g.apps) {
        if (a.userId === b.id && a.status === 'pending') {
          a.status = 'cancelled';
          a.cancelReason = 'banned';
          a.decidedAt = at(banAt);
        }
      }
      for (const s of g.sessions) {
        if (s.doneAt && s.doneAt.getTime() > banAt)
          s.present = s.present.filter((id) => id !== b.id);
      }
    }
  }

  // ---------- вставка ігор ----------

  private async insertGames(): Promise<void> {
    const r = this.rng;
    const now = this.now;
    for (const g of this.plans) {
      const touched = [g.createdAt, g.publishedAt, g.startedAt, g.finishedAt, g.cancelledAt]
        .filter((d): d is Date => d !== null)
        .reduce((m, d) => (d > m ? d : m), g.createdAt);
      const [res] = await this.db
        .insert(games)
        .values({
          gmUserId: g.gm.id,
          title: g.title,
          description: g.description,
          systemId: g.systemId,
          systemOther: g.systemOther,
          genreId: g.genreId,
          format: g.format,
          city: g.city,
          address: g.address,
          platform: g.platform,
          kind: g.kind,
          startsAt: g.startsAt,
          durationMinutes: g.durationMinutes,
          recurrence: g.recurrence,
          weekdays: g.weekdays,
          timezone: g.timezone,
          minPlayers: g.minPlayers,
          maxPlayers: g.maxPlayers,
          priceUah: g.priceUah,
          ageRating: g.ageRating,
          experience: g.experience,
          language: g.language,
          requirements: g.requirements,
          coverUrl: g.coverUrl,
          channelLinks: g.channelLinks,
          applicationQuestions: g.applicationQuestions,
          customWarnings: g.customWarnings,
          status: g.status,
          showWhenFull: g.showWhenFull,
          publishedAt: g.publishedAt,
          startedAt: g.startedAt,
          finishedAt: g.finishedAt,
          cancelledAt: g.cancelledAt,
          createdAt: g.createdAt,
          updatedAt: touched > now ? now : touched,
        })
        .$returningId();
      g.id = res!.id;
      await this.db.insert(demoEntities).values({ entityType: 'game', entityId: g.id });
      if (g.contentWarningIds.length) {
        await this.db
          .insert(gameContentWarnings)
          .values(g.contentWarningIds.map((warningId) => ({ gameId: g.id, warningId })));
      }
      if (g.sessions.length) {
        const ids = await this.db
          .insert(gameSessions)
          .values(
            g.sessions.map((s) => ({
              gameId: g.id,
              startsAt: s.startsAt,
              durationMinutes: s.durationMinutes,
              status: s.status,
              origin: s.origin,
              ruleStartsAt: s.ruleStartsAt,
              rescheduled: s.rescheduled,
              cancelReason: s.cancelReason,
              summary: s.summary,
              doneAt: s.doneAt,
              createdAt: s.createdAt,
              updatedAt: s.doneAt ?? s.cancelledAt ?? (s.cancelReason ? g.endAt : s.createdAt),
            })),
          )
          .$returningId();
        g.sessions.forEach((s, i) => (s.id = ids[i]!.id));
      }
      if (g.apps.length) {
        const ids = await this.db
          .insert(gameApplications)
          .values(
            g.apps.map((a) => ({
              gameId: g.id,
              userId: a.userId,
              status: a.status,
              message: a.message,
              answers: a.answers,
              constraints: a.constraints,
              warningsAcceptedAt: a.createdAt,
              cancelReason: a.cancelReason,
              createdAt: a.createdAt,
              decidedAt: a.decidedAt,
              decidedBy: a.decidedBy,
              updatedAt: a.decidedAt ?? a.createdAt,
            })),
          )
          .$returningId();
        g.apps.forEach((a, i) => (a.id = ids[i]!.id));
        const responses = g.apps.flatMap((a) =>
          a.responses.map((x) => ({
            applicationId: a.id,
            constraintId: x.constraintId,
            response: x.response,
            comment: x.comment,
            updatedAt: a.decidedAt ?? a.createdAt,
          })),
        );
        if (responses.length)
          await this.db.insert(applicationConstraintResponses).values(responses);
      }
      if (g.members.length) {
        const byKey = new Map(g.apps.map((a) => [a.key, a.id]));
        const ids = await this.db
          .insert(gameMembers)
          .values(
            g.members.map((m) => ({
              gameId: g.id,
              userId: m.userId,
              applicationId: byKey.get(m.applicationKey) ?? null,
              joinedAt: m.joinedAt,
              leftAt: m.leftAt,
              leftReason: m.leftReason,
              leaveNoteGm: m.leaveNoteGm,
            })),
          )
          .$returningId();
        g.members.forEach((m, i) => (m.id = ids[i]!.id));
        const bans = g.members.filter((m) => m.leftReason === 'banned');
        if (bans.length) {
          await this.db
            .insert(gameBans)
            .values(bans.map((m) => ({ gameId: g.id, userId: m.userId, createdAt: m.leftAt! })))
            .onDuplicateKeyUpdate({ set: { gameId: sql`${gameBans.gameId}` } });
        }
      }
      const attendance = g.sessions.flatMap((s) => {
        if (s.status !== 'done' || !s.hasAttendance) return [];
        const absent = (s as DSession & { absent?: number[] }).absent ?? [];
        return [
          ...s.present.map((userId) => ({ sessionId: s.id, userId, present: true })),
          ...absent.map((userId) => ({ sessionId: s.id, userId, present: false })),
        ];
      });
      for (const part of chunk(attendance)) await this.db.insert(sessionAttendance).values(part);
      // RSVP на найближчі сесії.
      const rsvp = g.sessions.flatMap((s) => {
        const until = s.startsAt.getTime() - now.getTime();
        if (s.status !== 'scheduled' || until <= 0 || until > 14 * DAY) return [];
        return g.members
          .filter((m) => m.leftAt === null && r.chance(0.55))
          .map((m) => ({
            sessionId: s.id,
            userId: m.userId,
            status: r.chance(0.85) ? ('going' as const) : ('not_going' as const),
            updatedAt: at(now.getTime() - r.float(0.05, 5) * DAY),
          }));
      });
      for (const part of chunk(rsvp)) await this.db.insert(sessionRsvp).values(part);
    }
  }

  // ---------- нотатки й чорний список ----------

  private async insertNotes(): Promise<void> {
    const r = this.rng;
    const rows: (typeof notes.$inferInsert)[] = [];
    for (const g of this.plans) {
      const done = g.sessions.filter((s) => s.status === 'done');
      if (g.kind !== 'campaign' || done.length === 0) continue;
      const lastDone = done[done.length - 1]!.doneAt!;
      const when = () => at(r.float(done[0]!.doneAt!.getTime(), lastDone.getTime() + 1));
      if (!g.isOwnerGame && r.chance(0.45)) {
        rows.push({
          scope: 'game_private',
          gameId: g.id,
          sessionId: null,
          userId: g.gm.id,
          body: r.sample(T.NOTES_PRIVATE, r.int(1, 2)).join('\n\n'),
          updatedAt: when(),
        });
      }
      for (const m of g.members) {
        if (r.chance(0.25))
          rows.push({
            scope: 'game_shared',
            gameId: g.id,
            sessionId: null,
            userId: m.userId,
            body: r.pick(T.NOTES_PLAYER_SHARED),
            updatedAt: when(),
          });
        if (r.chance(0.1))
          rows.push({
            scope: 'game_private',
            gameId: g.id,
            sessionId: null,
            userId: m.userId,
            body: r.pick(T.NOTES_PRIVATE),
            updatedAt: when(),
          });
      }
      for (const s of done) {
        const author = s.present.length && r.chance(0.06) ? r.pick(s.present) : null;
        if (author)
          rows.push({
            scope: 'session_private',
            gameId: g.id,
            sessionId: s.id,
            userId: author,
            body: r.pick(T.NOTES_PRIVATE),
            updatedAt: s.doneAt!,
          });
      }
    }
    for (const part of chunk(rows)) await this.db.insert(notes).values(part);
  }

  private async insertBlacklist(): Promise<void> {
    const r = this.rng;
    const now = this.now.getTime();
    const target = this.n(10, 2);
    const rows = new Map<string, { gmUserId: number; userId: number; createdAt: Date }>();
    const busyWith = (gmId: number, userId: number) =>
      this.plans.some(
        (g) =>
          g.gm.id === gmId &&
          (g.members.some((m) => m.userId === userId && m.leftAt === null) ||
            g.apps.some((a) => a.userId === userId && a.status === 'pending')),
      );
    /** Остання активність людини в іграх майстра: чорний список — лише після неї (заявки потім заблоковані). */
    const lastContact = (gmId: number, userId: number) => {
      let last = 0;
      for (const g of this.plans) {
        if (g.gm.id !== gmId) continue;
        for (const a of g.apps) {
          if (a.userId === userId) last = Math.max(last, (a.decidedAt ?? a.createdAt).getTime());
        }
        for (const m of g.members)
          if (m.userId === userId && m.leftAt) last = Math.max(last, m.leftAt.getTime());
      }
      return last;
    };
    const add = (gmId: number, userId: number, from: number) => {
      const lo = Math.max(from, lastContact(gmId, userId)) + r.float(0.1, 24) * HOUR;
      if (lo >= now - MIN) return;
      rows.set(`${gmId}:${userId}`, { gmUserId: gmId, userId, createdAt: at(lo) });
    };
    // Спершу — виключені/забанені в грі; далі — випадкові давні співгравці.
    for (const g of r.shuffle(this.plans)) {
      for (const m of g.members) {
        if (
          (m.leftReason === 'kicked' || m.leftReason === 'banned') &&
          r.chance(0.8) &&
          !busyWith(g.gm.id, m.userId)
        ) {
          add(g.gm.id, m.userId, m.leftAt!.getTime());
        }
      }
    }
    for (let i = 0; rows.size < target && i < 200; i++) {
      const gm = r.pick(this.gms);
      const u = r.pick(this.people);
      if (u.id === gm.id || busyWith(gm.id, u.id) || rows.has(`${gm.id}:${u.id}`)) continue;
      add(gm.id, u.id, now - r.float(1, 90) * DAY);
    }
    if (rows.size) await this.db.insert(gmBlacklist).values([...rows.values()]);
  }

  // ---------- оцінки ----------

  private score(mean: number): number {
    return Math.max(1, Math.min(5, Math.round(this.rng.normal(mean, 0.65))));
  }

  private review(role: RatingRole, overall: number, g: DGame): string {
    const r = this.rng;
    const gm = role === 'gm';
    const campaign = g.kind === 'campaign';
    // Довгі відгуки про «кілька місяців» і «першу сесію» — лише для кампаній.
    if (overall >= 4 && gm && r.chance(0.08)) {
      return r.pick(
        campaign ? [T.REVIEW_LONG[0]!, T.REVIEW_LONG[1]!] : [T.REVIEW_LONG[0]!, T.REVIEW_LONG[3]!],
      );
    }
    if (overall === 3 && gm && campaign && r.chance(0.1)) return T.REVIEW_LONG[2]!;
    const pool =
      overall >= 4
        ? gm
          ? T.REVIEW_GM_GOOD
          : T.REVIEW_PLAYER_GOOD
        : overall === 3
          ? gm
            ? T.REVIEW_GM_MIXED
            : T.REVIEW_PLAYER_MIXED
          : gm
            ? T.REVIEW_GM_BAD
            : T.REVIEW_PLAYER_BAD;
    // `cancel:` — фраза про скасовані сесії, лише якщо майстер справді скасовував.
    const hadCancels = g.sessions.some((s) => s.cancelledAt !== null);
    const usable = pool
      .filter((p) => !p.startsWith('cancel:') || hadCancels)
      .map((p) => p.replace(/^cancel:/, ''));
    const n = overall >= 4 && r.chance(0.35) ? 2 : 1;
    return r
      .sample(usable, n)
      .map((s) => s.replace('{praise}', r.pick(g.praise)))
      .join(' ');
  }

  private makeRating(
    g: DGame,
    raterId: number,
    rateeId: number,
    sessionId: number | null,
    createdAt: number,
  ): DRating {
    const r = this.rng;
    const role: RatingRole =
      rateeId === g.gm.id ? 'gm' : raterId === g.gm.id ? 'player_from_gm' : 'player_from_player';
    const ratee =
      rateeId === this.owner?.id ? this.owner : this.people.find((p) => p.id === rateeId)!;
    const base = {
      raterId,
      rateeId,
      gameId: g.id,
      sessionId,
      role,
      createdAt: at(createdAt),
    };
    if (r.chance(0.09))
      return { ...base, declined: true, overall: null, criteria: null, comment: null };
    const overall = this.score(ratee.quality);
    let criteria: DRating['criteria'] = null;
    const all = criteriaForRole(role);
    const mode = r.weighted([
      ['all', 6],
      ['some', 2.5],
      ['none', 1.5],
    ] as const);
    if (mode !== 'none') {
      criteria = {};
      for (const k of mode === 'all' ? all : r.sample(all, r.int(1, all.length - 1))) {
        criteria[k] = Math.max(1, Math.min(5, Math.round(overall + r.normal(0, 0.5))));
      }
    }
    const comment = r.chance(role === 'gm' ? 0.42 : 0.15) ? this.review(role, overall, g) : null;
    return { ...base, declined: false, overall, criteria, comment };
  }

  /** Пари, що були разом на `done` сесії (майстер — на всіх). */
  private presence(g: DGame): Map<number, Set<number>> {
    const out = new Map<number, Set<number>>();
    for (const s of g.sessions) {
      if (s.status === 'done') out.set(s.id, new Set([g.gm.id, ...s.present]));
    }
    return out;
  }

  private planRatings(): DRating[] {
    const r = this.rng;
    const now = this.now.getTime();
    const out: DRating[] = [];
    const seen = new Set<string>();
    const canRate = (id: number, when: number) => {
      if (this.owner && id === this.owner.id) return false; // за власника не оцінюємо
      const u = this.people.find((p) => p.id === id);
      return !!u && (!u.bannedAt || u.bannedAt.getTime() > when);
    };
    const add = (x: DRating) => {
      const key = `${x.raterId}:${x.rateeId}:${x.gameId}:${x.sessionId ?? 0}`;
      if (seen.has(key) || x.createdAt.getTime() > now - MIN) return;
      seen.add(key);
      out.push(x);
    };
    const prob = (raterIsGm: boolean, rateeIsGm: boolean, final: boolean) =>
      rateeIsGm ? (final ? 0.75 : 0.35) : raterIsGm ? (final ? 0.6 : 0.2) : final ? 0.35 : 0.08;

    for (const g of this.plans) {
      const pres = this.presence(g);
      if (pres.size === 0) continue;
      const gmId = g.gm.id;
      if (g.kind === 'campaign') {
        for (const s of g.sessions) {
          const set = pres.get(s.id);
          if (!set) continue;
          const doneAt = s.doneAt!.getTime();
          const closes = Math.min(now - MIN, doneAt + SESSION_RATING_WINDOW_DAYS * DAY - HOUR);
          for (const a of set)
            for (const b of set) {
              if (a === b || !r.chance(prob(a === gmId, b === gmId, false))) continue;
              const when = r.float(
                doneAt + 10 * MIN,
                Math.max(doneAt + 11 * MIN, Math.min(closes, doneAt + 3 * DAY)),
              );
              if (canRate(a, when)) add(this.makeRating(g, a, b, s.id, when));
            }
        }
      }
      const together = new Set<string>();
      for (const set of pres.values())
        for (const a of set) for (const b of set) if (a !== b) together.add(`${a}:${b}`);
      if (g.status === 'finished') {
        const fin = g.finishedAt!.getTime();
        const closes = Math.min(now - MIN, fin + FINAL_RATING_WINDOW_DAYS * DAY - HOUR);
        for (const key of together) {
          const [a, b] = key.split(':').map(Number) as [number, number];
          if (!r.chance(prob(a === gmId, b === gmId, true))) continue;
          const when = r.float(
            fin + 10 * MIN,
            Math.max(fin + 11 * MIN, Math.min(closes, fin + 10 * DAY)),
          );
          if (canRate(a, when)) add(this.makeRating(g, a, b, null, when));
        }
      } else {
        // «Вихідні» пари: хтось вийшов після спільної сесії — підсумкова оцінка без кінця гри.
        for (const m of g.members) {
          if (!m.leftAt || m.leftReason === 'banned_by_admin') continue;
          const L = m.leftAt.getTime();
          const sharedBefore = g.sessions.some(
            (s) => s.status === 'done' && s.doneAt!.getTime() <= L && pres.get(s.id)!.has(m.userId),
          );
          if (!sharedBefore) continue;
          const limit =
            g.status === 'cancelled'
              ? g.cancelledAt!.getTime() + FINAL_RATING_WINDOW_DAYS * DAY - HOUR
              : now - MIN;
          const when = r.float(L + 10 * MIN, Math.max(L + 11 * MIN, Math.min(limit, L + 10 * DAY)));
          if (r.chance(0.3) && canRate(m.userId, when))
            add(this.makeRating(g, m.userId, gmId, null, when));
          if (r.chance(0.3) && canRate(gmId, when))
            add(this.makeRating(g, gmId, m.userId, null, when));
        }
      }
    }
    return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /**
   * Оцінки — по одній, у хронологічному порядку, кожна з одразу наступним `maybePublish` (як
   * `submitRating`, у транзакції сидера): зрізи публікуються тими самими пачками по 5 одиниць.
   */
  private async insertRatings(): Promise<number> {
    const list = this.planRatings();
    const lastAt = new Map<number, Date>();
    for (const x of list) {
      const [res] = await this.db
        .insert(ratings)
        .values({
          raterId: x.raterId,
          rateeId: x.rateeId,
          gameId: x.gameId,
          sessionId: x.sessionId,
          kind: x.sessionId === null ? 'final' : 'session',
          role: x.role,
          declined: x.declined,
          overall: x.overall,
          criteria: x.criteria,
          comment: x.comment,
          createdAt: x.createdAt,
        })
        .$returningId();
      await maybePublish(this.db, x.rateeId, x.role);
      const id = res!.id;
      lastAt.set(id, x.createdAt);
    }
    // Момент публікації — час оцінки, що замкнула пачку (а не час запуску сидера).
    const ratees = [...new Set(list.map((x) => x.rateeId))];
    for (const part of chunk(ratees)) {
      const rows = await this.db
        .select({
          userId: publishedRatings.userId,
          role: publishedRatings.role,
          last: publishedRatings.lastRatingId,
        })
        .from(publishedRatings)
        .where(inArray(publishedRatings.userId, part));
      for (const row of rows) {
        const when = row.last !== null ? lastAt.get(row.last) : undefined;
        if (!when) continue;
        await this.db
          .update(publishedRatings)
          .set({ publishedAt: when })
          .where(and(eq(publishedRatings.userId, row.userId), eq(publishedRatings.role, row.role)));
      }
    }
    return list.length;
  }

  // ---------- модерація ----------

  private async insertModeration(): Promise<void> {
    const r = this.rng;
    const now = this.now.getTime();
    const mods = this.moderators;
    const mod = () => (mods.length ? r.pick(mods).id : this.adminActorId);
    const logRows: (typeof moderationLog.$inferInsert)[] = [];
    for (const m of mods) {
      logRows.push({
        actorId: this.owner?.id ?? this.adminActorId,
        action: 'role.change',
        targetType: 'user',
        targetId: m.id,
        meta: { from: 'user', to: 'moderator' },
        createdAt: at(m.createdAt.getTime() + 20 * DAY),
      });
    }

    // Хто з ким перетинався (для скарг на людей): учасники однієї гри.
    const crossed = (a: number, b: number) =>
      this.plans.some((g) => {
        const ids = new Set([g.gm.id, ...g.members.map((m) => m.userId)]);
        return ids.has(a) && ids.has(b);
      });
    const staffIds = new Set(mods.map((m) => m.id));
    const targets = this.people.filter((p) => !staffIds.has(p.id) && p !== this.banned);
    const published = this.plans.filter((g) => g.publishedAt && !g.isOwnerGame);

    const sanctionsToMake: {
      userId: number;
      type: 'warning' | 'application_limit' | 'no_paid_create' | 'global_ban';
      days: number | null;
      startsAt: number;
      imposedBy: number | null;
      complaintIdx?: number;
      appeal?: { message: string; status: 'pending' | 'accepted' | 'rejected'; note?: string };
      lifted?: boolean;
    }[] = [];

    const complaintRows: { row: typeof complaints.$inferInsert; actioned: boolean }[] = [];
    const nComplaints = Math.min(T.COMPLAINTS.length, this.n(9, 4));
    for (let i = 0; i < nComplaints; i++) {
      const c = T.COMPLAINTS[i]!;
      const created = now - r.float(0.5, 40) * DAY;
      let reporterId: number | null = null;
      let targetUserId: number | null = null;
      let targetGameId: number | null = null;
      if (c.target === 'user') {
        for (let tries = 0; tries < 50 && reporterId === null; tries++) {
          const t = r.pick(targets);
          const rep = r.pick(this.people);
          if (rep.id !== t.id && !staffIds.has(rep.id) && crossed(rep.id, t.id)) {
            reporterId = rep.id;
            targetUserId = t.id;
          }
        }
      } else if (published.length) {
        const g = r.pick(published);
        const rep = r.pick(this.people.filter((p) => p.id !== g.gm.id && !staffIds.has(p.id)));
        reporterId = rep.id;
        targetGameId = g.id;
      }
      if (reporterId === null) continue;
      // Перші — нові (черга модераторів), далі розглянуті.
      const status: 'new' | 'dismissed' | 'actioned' =
        i < Math.ceil(nComplaints * 0.5) ? 'new' : i % 2 === 0 ? 'actioned' : 'dismissed';
      const resolvedAt =
        status === 'new' ? null : at(Math.min(now - HOUR, created + r.float(2, 72) * HOUR));
      complaintRows.push({
        row: {
          reporterId,
          targetUserId,
          targetGameId,
          reason: c.reason as (typeof complaints.$inferInsert)['reason'],
          message: c.text,
          status,
          resolvedBy: status === 'new' ? null : mod(),
          resolvedAt,
          createdAt: at(created),
        },
        actioned: status === 'actioned' && targetUserId !== null,
      });
    }

    // Санкції: бан (з апеляцією), обмеження заявок (апеляція чекає), попередження, заборона платних ігор.
    if (this.banned) {
      sanctionsToMake.push({
        userId: this.banned.id,
        type: 'global_ban',
        days: null,
        startsAt: this.banned.bannedAt!.getTime(),
        imposedBy: this.adminActorId,
        appeal: { message: T.APPEALS[2], status: 'pending' },
      });
    }
    const pool = r.shuffle(targets.filter((p) => !p.isGm));
    const limitUser = pool[0];
    const warnUser = pool[1];
    const oldWarnUser = pool[2];
    const paidGm = this.gms.find(
      (g) => g !== this.gms[0] && this.plans.some((p) => p.gm === g && p.priceUah),
    );
    const actionedIdx = complaintRows.findIndex((c) => c.actioned);
    if (limitUser)
      sanctionsToMake.push({
        userId: limitUser.id,
        type: 'application_limit',
        days: 30,
        startsAt: now - 5 * DAY,
        imposedBy: mod(),
        appeal: { message: T.APPEALS[0], status: 'pending' },
      });
    if (warnUser) {
      const idx = actionedIdx >= 0 ? actionedIdx : undefined;
      const tgt = idx !== undefined ? complaintRows[idx]!.row.targetUserId! : warnUser.id;
      sanctionsToMake.push({
        userId: tgt,
        type: 'warning',
        days: 30,
        startsAt: idx !== undefined ? complaintRows[idx]!.row.resolvedAt!.getTime() : now - 9 * DAY,
        imposedBy: mod(),
        complaintIdx: idx,
      });
    }
    if (oldWarnUser)
      sanctionsToMake.push({
        userId: oldWarnUser.id,
        type: 'warning',
        days: 7,
        startsAt: now - 80 * DAY,
        imposedBy: mod(),
      });
    if (paidGm)
      sanctionsToMake.push({
        userId: paidGm.id,
        type: 'no_paid_create',
        days: 90,
        startsAt: now - 20 * DAY,
        imposedBy: mod(),
        appeal: {
          message: T.APPEALS[1],
          status: 'rejected',
          note: 'Скарги підтверджено кількома учасниками.',
        },
      });

    const complaintIds: number[] = [];
    for (const c of complaintRows) {
      const [res] = await this.db.insert(complaints).values(c.row).$returningId();
      complaintIds.push(res!.id);
      if (c.row.status !== 'new') {
        logRows.push({
          actorId: c.row.resolvedBy ?? null,
          action: c.row.status === 'actioned' ? 'complaint.action' : 'complaint.dismiss',
          targetType: 'complaint',
          targetId: res!.id,
          createdAt: c.row.resolvedAt!,
        });
        this.notifs.push({
          userId: c.row.reporterId,
          type: 'complaint.resolved',
          category: 'moderation',
          params: {},
          entityType: 'complaint',
          entityId: res!.id,
          createdAt: c.row.resolvedAt!,
        });
      }
    }

    const durationOf = (d: number | null) => (d === null ? 'permanent' : `${d}d`);
    for (const s of sanctionsToMake) {
      const startsAt = at(s.startsAt);
      const endsAt = s.days === null ? null : at(s.startsAt + s.days * DAY);
      const complaintId = s.complaintIdx !== undefined ? complaintIds[s.complaintIdx]! : null;
      const reason = T.SANCTION_REASONS[s.type];
      const [res] = await this.db
        .insert(sanctions)
        .values({
          userId: s.userId,
          type: s.type,
          reason,
          imposedBy: s.imposedBy,
          startsAt,
          endsAt,
          complaintId,
          createdAt: startsAt,
        })
        .$returningId();
      const sanctionId = res!.id;
      if (complaintId !== null)
        await this.db.update(complaints).set({ sanctionId }).where(eq(complaints.id, complaintId));
      logRows.push({
        actorId: s.imposedBy,
        action: 'sanction.impose',
        targetType: 'user',
        targetId: s.userId,
        reason,
        meta: {
          sanctionId,
          type: s.type,
          duration: durationOf(s.days),
          ...(complaintId !== null ? { complaintId } : {}),
        },
        createdAt: startsAt,
      });
      this.notifs.push({
        userId: s.userId,
        type: 'sanction.imposed',
        category: 'moderation',
        params: { sanctionType: s.type, endsAt: endsAt ? endsAt.toISOString() : null, reason },
        entityType: 'sanction',
        entityId: sanctionId,
        createdAt: startsAt,
      });
      if (endsAt && endsAt.getTime() < now) {
        logRows.push({
          actorId: null,
          action: 'sanction.expire',
          targetType: 'sanction',
          targetId: sanctionId,
          createdAt: endsAt,
        });
      }
      if (s.type === 'global_ban') {
        await this.db
          .update(users)
          .set({ isBanned: true, banEpoch: 1, updatedAt: startsAt })
          .where(eq(users.id, s.userId));
      }
      if (s.appeal) {
        const created = at(s.startsAt + r.float(3, 48) * HOUR);
        const decided =
          s.appeal.status === 'pending'
            ? null
            : at(Math.min(now - HOUR, created.getTime() + r.float(12, 96) * HOUR));
        const decider = s.type === 'global_ban' ? this.adminActorId : mod();
        const [ap] = await this.db
          .insert(sanctionAppeals)
          .values({
            sanctionId,
            userId: s.userId,
            message: s.appeal.message,
            status: s.appeal.status,
            decidedBy: decided ? decider : null,
            decidedAt: decided,
            decisionNote: s.appeal.note ?? null,
            createdAt: created,
          })
          .$returningId();
        if (decided) {
          logRows.push({
            actorId: decider,
            action: s.appeal.status === 'accepted' ? 'appeal.accept' : 'appeal.reject',
            targetType: 'appeal',
            targetId: ap!.id,
            reason: s.appeal.note ?? null,
            createdAt: decided,
          });
          this.notifs.push({
            userId: s.userId,
            type: 'appeal.decided',
            category: 'moderation',
            params: { accepted: s.appeal.status === 'accepted', sanctionType: s.type },
            entityType: 'sanction',
            entityId: sanctionId,
            createdAt: decided,
          });
        }
      }
      const u = this.people.find((p) => p.id === s.userId);
      if (u)
        this.sanctionNotes.push({
          label: `${s.type}${s.appeal ? ` (appeal ${s.appeal.status})` : ''}`,
          nickname: u.nickname,
        });
    }

    // Модерація відгуків: прихований текст кількох різких коментарів.
    const harsh = await this.db
      .select({ id: ratings.id, createdAt: ratings.createdAt })
      .from(ratings)
      .where(
        and(
          inArray(
            ratings.raterId,
            this.people.map((p) => p.id),
          ),
          sql`${ratings.comment} is not null`,
          sql`${ratings.overall} <= 2`,
        ),
      )
      .orderBy(ratings.id)
      .limit(2);
    for (const h of harsh) {
      const when = at(Math.min(now - HOUR, h.createdAt.getTime() + r.float(2, 48) * HOUR));
      const by = mod();
      await this.db
        .update(ratings)
        .set({ moderated: 'text_hidden', moderatedBy: by, moderatedAt: when })
        .where(eq(ratings.id, h.id));
      logRows.push({
        actorId: by,
        action: 'rating.hide_text',
        targetType: 'rating',
        targetId: h.id,
        reason: 'Особисті образи у відгуку.',
        createdAt: when,
      });
    }
    logRows.sort((a, b) => a.createdAt!.getTime() - b.createdAt!.getTime());
    for (const part of chunk(logRows)) await this.db.insert(moderationLog).values(part);
  }

  // ---------- «мертві» й «підозрілі» ігри ----------

  /**
   * Повторює щоденний детектор (`runDeadGamesDetector`) лише для демо-ігор: ті самі правила
   * й ключі періодів у `game_staleness_log` (справжній детектор не надішле дублів), позначки
   * без зміни `updated_at`. Не-демо ігри не чіпаються.
   */
  private async flagStaleGames(): Promise<void> {
    const r = this.rng;
    const now = this.now;
    const checked = this.plans.filter((g) => g.status === 'recruiting' || g.status === 'started');
    if (checked.length === 0) return;
    const anchors = await sessionAnchors(
      this.db,
      checked.map((g) => g.id),
      now,
    );
    const keep = { updatedAt: sql`${games.updatedAt}` };
    const logRows: (typeof gameStalenessLog.$inferInsert)[] = [];
    const notify = (g: DGame, type: NotificationType, createdAt: Date) =>
      this.notifs.push({
        userId: g.gm.id,
        type,
        category: 'games',
        params: { gameId: g.id, gameTitle: g.title },
        entityType: 'game',
        entityId: g.id,
        createdAt,
      });
    for (const g of checked) {
      const input = staleInputOf(
        {
          status: g.status,
          publishedAt: g.publishedAt,
          startsAt: g.startsAt,
          deadSnoozedUntil: null,
          deadExemptUntilSession: false,
        },
        anchors.get(g.id),
      );
      const verdict = staleRule(input, now);
      if (verdict === 'ok') continue;
      const anchor = staleAnchor(input)!;
      const period = `${anchor.toISOString()}|-`;
      // Нагадування приходило на 31-й день, позначка «мертва» — на 91-й (детектор щоденний).
      const remindAt = at(
        Math.min(now.getTime() - HOUR, anchor.getTime() + 31 * DAY + r.float(0, 20) * HOUR),
      );
      logRows.push({
        gameId: g.id,
        kind: 'stale_reminder',
        periodKey: period,
        createdAt: remindAt,
      });
      notify(g, 'game.stale_reminder', remindAt);
      if (verdict === 'dead') {
        const deadAt = at(
          Math.min(now.getTime() - HOUR, anchor.getTime() + 91 * DAY + r.float(0, 20) * HOUR),
        );
        await this.db
          .update(games)
          .set({ deadAt, ...keep })
          .where(eq(games.id, g.id));
        logRows.push({ gameId: g.id, kind: 'dead', periodKey: period, createdAt: deadAt });
        notify(g, 'game.dead', deadAt);
      }
    }
    const byGm = new Map<number, DGame[]>();
    for (const g of checked) byGm.set(g.gm.id, [...(byGm.get(g.gm.id) ?? []), g]);
    for (const [gmId, list] of byGm) {
      if (list.length < 2) continue;
      const flagged = await overlapRule(this.db, gmId, now);
      for (const g of list) {
        if (!flagged.has(g.id)) continue;
        const when = at(now.getTime() - r.float(1, 40) * HOUR);
        await this.db
          .update(games)
          .set({ suspiciousAt: when, ...keep })
          .where(eq(games.id, g.id));
        logRows.push({
          gameId: g.id,
          kind: 'suspicious',
          periodKey: when.toISOString().slice(0, 10),
          createdAt: when,
        });
        notify(g, 'game.suspicious', when);
      }
    }
    for (const part of chunk(logRows)) await this.db.insert(gameStalenessLog).values(part);
  }

  // ---------- сповіщення ----------

  private actor(id: number | null): NotificationParams['actor'] {
    if (id === null) return null;
    const u = id === this.owner?.id ? this.owner : this.people.find((p) => p.id === id);
    return u ? { publicId: u.publicId, nickname: u.nickname } : null;
  }

  /** Сповіщення, які створив би диспетчер з подій (`recipients.ts`), з історичним часом. */
  private planActivityNotifications(): void {
    const push = (n: DNotification) => this.notifs.push(n);
    const now = this.now.getTime();
    for (const g of this.plans) {
      if (g.status === 'draft') continue;
      const base = { gameId: g.id, gameTitle: g.title };
      for (const a of g.apps) {
        const app = { ...base, applicationId: a.id };
        push({
          userId: g.gm.id,
          type: 'application.created',
          category: 'applications',
          params: { ...app, actor: this.actor(a.userId) },
          entityType: 'application',
          entityId: a.id,
          createdAt: a.createdAt,
        });
        if (!a.decidedAt) continue;
        const type: NotificationType | null =
          a.status === 'approved'
            ? 'application.approved'
            : a.status === 'rejected'
              ? 'application.rejected'
              : a.status === 'cancelled' && a.cancelReason !== 'banned'
                ? 'application.cancelled_game'
                : null;
        if (type)
          push({
            userId: a.userId,
            type,
            category: 'applications',
            params: {
              ...app,
              actor: type === 'application.cancelled_game' ? null : this.actor(g.gm.id),
            },
            entityType: 'application',
            entityId: a.id,
            createdAt: a.decidedAt,
          });
        if (a.status === 'withdrawn')
          push({
            userId: g.gm.id,
            type: 'application.withdrawn',
            category: 'applications',
            params: { ...app, reason: null, actor: this.actor(a.userId) },
            entityType: 'application',
            entityId: a.id,
            createdAt: a.decidedAt,
          });
      }
      const membersAt = (t: number) =>
        g.members
          .filter((m) => m.joinedAt.getTime() <= t && (!m.leftAt || m.leftAt.getTime() > t))
          .map((m) => m.userId);
      for (const m of g.members) {
        if (!m.leftAt) continue;
        if (m.leftReason === 'left')
          push({
            userId: g.gm.id,
            type: 'member.left',
            category: 'members',
            params: { ...base, reason: null, actor: this.actor(m.userId) },
            entityType: 'game',
            entityId: g.id,
            createdAt: m.leftAt,
          });
        if (m.leftReason === 'kicked' || m.leftReason === 'banned')
          push({
            userId: m.userId,
            type: m.leftReason === 'kicked' ? 'member.kicked' : 'member.banned',
            category: 'members',
            params: { ...base, actor: this.actor(g.gm.id) },
            entityType: 'game',
            entityId: g.id,
            createdAt: m.leftAt,
          });
      }
      for (const s of g.sessions) {
        if (s.cancelledAt && s.cancelReason) {
          for (const u of membersAt(s.cancelledAt.getTime()))
            push({
              userId: u,
              type: 'session.cancelled',
              category: 'sessions',
              params: {
                ...base,
                sessionId: s.id,
                startsAt: s.startsAt.toISOString(),
                reason: s.cancelReason,
                actor: this.actor(g.gm.id),
              },
              entityType: 'session',
              entityId: s.id,
              createdAt: s.cancelledAt,
            });
        }
        // Запрошення оцінити свіжу сесію кампанії (вікно ще відкрите).
        if (
          g.kind === 'campaign' &&
          s.status === 'done' &&
          now - s.doneAt!.getTime() < SESSION_RATING_WINDOW_DAYS * DAY &&
          s.present.length
        ) {
          const closesAt = new Date(
            s.doneAt!.getTime() + SESSION_RATING_WINDOW_DAYS * DAY,
          ).toISOString();
          for (const u of [g.gm.id, ...s.present])
            push({
              userId: u,
              type: 'rating.session_open',
              category: 'ratings',
              params: { ...base, sessionId: s.id, closesAt },
              entityType: 'session',
              entityId: s.id,
              createdAt: s.doneAt!,
            });
        }
      }
      if (g.startedAt && g.startedAt.getTime() <= now) {
        for (const u of membersAt(g.startedAt.getTime()))
          push({
            userId: u,
            type: 'game.started',
            category: 'games',
            params: { ...base, actor: this.actor(g.gm.id) },
            entityType: 'game',
            entityId: g.id,
            createdAt: g.startedAt,
          });
      }
      if (g.finishedAt) {
        const t = g.finishedAt.getTime();
        const closesAt = new Date(t + FINAL_RATING_WINDOW_DAYS * DAY).toISOString();
        for (const u of membersAt(t)) {
          push({
            userId: u,
            type: 'game.finished',
            category: 'games',
            params: { ...base, genreSlug: g.genreSlug, actor: this.actor(g.gm.id) },
            entityType: 'game',
            entityId: g.id,
            createdAt: g.finishedAt,
          });
          push({
            userId: u,
            type: 'rating.final_open',
            category: 'ratings',
            params: { ...base, closesAt },
            entityType: 'game',
            entityId: g.id,
            createdAt: g.finishedAt,
          });
        }
        push({
          userId: g.gm.id,
          type: 'rating.final_open',
          category: 'ratings',
          params: { ...base, closesAt },
          entityType: 'game',
          entityId: g.id,
          createdAt: g.finishedAt,
        });
      }
      if (g.cancelledAt) {
        for (const u of membersAt(g.cancelledAt.getTime()))
          push({
            userId: u,
            type: 'game.cancelled',
            category: 'games',
            params: { ...base, reason: null, actor: this.actor(g.gm.id) },
            entityType: 'game',
            entityId: g.id,
            createdAt: g.cancelledAt,
          });
      }
    }
  }

  private async insertNotifications(): Promise<void> {
    const r = this.rng;
    const now = this.now.getTime();
    const active = new Set([
      ...this.people.map((p) => p.id),
      ...(this.owner ? [this.owner.id] : []),
    ]);
    const rows = this.notifs
      .filter((n) => active.has(n.userId) && n.createdAt.getTime() <= now)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((n) => {
        const age = now - n.createdAt.getTime();
        const read = age > 2 * DAY ? r.chance(0.85) : r.chance(0.25);
        const readAt = read
          ? at(
              Math.min(
                now - MIN,
                n.createdAt.getTime() + r.float(5 * MIN, Math.max(6 * MIN, Math.min(age, 2 * DAY))),
              ),
            )
          : null;
        return {
          eventId: null,
          userId: n.userId,
          type: n.type,
          category: n.category,
          payload: n.params,
          entityType: n.entityType,
          entityId: n.entityId,
          createdAt: n.createdAt,
          readAt,
        };
      });
    for (const part of chunk(rows)) await this.db.insert(notifications).values(part);
  }

  // ---------- зведення ----------

  private async interestingAccounts(): Promise<DemoAccount[]> {
    const out: DemoAccount[] = [];
    const nickOf = (id: number) => this.people.find((p) => p.id === id)?.nickname;
    const gmGames = new Map<number, number>();
    for (const g of this.plans)
      if (!g.isOwnerGame) gmGames.set(g.gm.id, (gmGames.get(g.gm.id) ?? 0) + 1);
    const busiest = [...gmGames.entries()].sort((a, b) => b[1] - a[1])[0];
    if (busiest)
      out.push({ label: `busy GM (${busiest[1]} games)`, nickname: nickOf(busiest[0])! });
    const dead = this.plans.find((g) => g.special === 'dead');
    if (dead)
      out.push({ label: 'GM with dead games (game creation blocked)', nickname: dead.gm.nickname });
    const overlap = this.plans.find((g) => g.special === 'overlap');
    if (overlap)
      out.push({
        label: 'GM with overlapping sessions (suspicious)',
        nickname: overlap.gm.nickname,
      });
    const pending = new Map<number, number>();
    for (const g of this.plans)
      for (const a of g.apps)
        if (a.status === 'pending') pending.set(a.userId, (pending.get(a.userId) ?? 0) + 1);
    const topPending = [...pending.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topPending)
      out.push({
        label: `player with ${topPending[1]} pending applications`,
        nickname: nickOf(topPending[0])!,
      });
    const [ratedPlayer] = await this.db
      .select({ userId: publishedRatings.userId, units: publishedRatings.units })
      .from(publishedRatings)
      .where(
        and(
          inArray(
            publishedRatings.userId,
            this.people.filter((p) => !p.isGm && p.role === 'user' && !p.bannedAt).map((p) => p.id),
          ),
          sql`${publishedRatings.overall} is not null`,
        ),
      )
      .orderBy(sql`${publishedRatings.units} desc`)
      .limit(1);
    if (ratedPlayer)
      out.push({
        label: `veteran player (published rating, ${ratedPlayer.units} units)`,
        nickname: nickOf(ratedPlayer.userId)!,
      });
    const minor = this.people.find((p) => this.ageNow(p) < 18);
    if (minor)
      out.push({
        label: `minor (${this.ageNow(minor)} y.o., ${this.ageNow(minor) >= 16 ? '16+ visible, ' : ''}18+ hidden)`,
        nickname: minor.nickname,
      });
    for (const m of this.moderators) out.push({ label: 'moderator', nickname: m.nickname });
    if (this.banned)
      out.push({
        label: 'globally banned (dev-login shows ban screen, appeal pending)',
        nickname: this.banned.nickname,
      });
    const limited = this.sanctionNotes.find((s) => s.label.startsWith('application_limit'));
    if (limited)
      out.push({ label: 'application limit + pending appeal', nickname: limited.nickname });
    const abroad =
      this.people.find((p) => p.timezone === 'America/Toronto') ??
      this.people.find((p) => p.timezone !== 'Europe/Kyiv');
    if (abroad)
      out.push({ label: `player abroad (${abroad.timezone})`, nickname: abroad.nickname });
    return out;
  }
}
