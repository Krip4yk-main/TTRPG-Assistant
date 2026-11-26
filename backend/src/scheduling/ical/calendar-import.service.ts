import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';
import {
  CALENDAR_IMPORT_HORIZON_DAYS,
  CALENDAR_IMPORT_MANUAL_SYNC_MS,
  CALENDAR_IMPORT_MAX_FAILURES,
  CALENDAR_IMPORT_SYNC_EVERY_MS,
  calendarImportInputSchema,
  type BusyInterval,
  type CalendarImportErrorCode,
  type CalendarImportStatusDto,
} from '@nri/shared';
import type { AppDeps } from '../../app.js';
import type { Tx } from '../../applications/applications.rules.js';
import type { Db } from '../../db/client.js';
import { calendarImportBusy, calendarImports, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import {
  createOptionalNotification,
  emitNotificationsNew,
  type NotificationRow,
} from '../../notifications/notifications.service.js';
import { decryptWithKeys, encryptUrl, importKey, importKeys, type ImportKeys } from './crypto.js';
import { CalendarImportError } from './errors.js';
import { createIcsFetcher } from './fetch.js';
import type { IcsParseResult } from './ics-parse.js';
import { parseIcsInWorker } from './parse-runner.js';
import { IMPORT_SLOT_WAIT_MS, importSlots } from './slots.js';
import { literalHost, normalizeIcsUrl } from './ssrf.js';

export const CALENDAR_IMPORT_JOB = 'schedule.calendar_import';
/**
 * Джоб — кожні 15 хв, але кожне посилання оновлюється раз на `CALENDAR_IMPORT_SYNC_EVERY_MS`
 * (3 год) від своєї останньої спроби: навантаження розподілене в часі (хто коли підключив).
 */
export const CALENDAR_IMPORT_EVERY_MS = 15 * 60_000;
/** Посилань за один прогін і одночасних завантажень. */
const SYNC_BATCH = 200;
const SYNC_CONCURRENCY = 4;
/**
 * Після цього нових посилань у прогоні не беремо: воркер джобів виконує задачі по черзі, тож
 * довгий прогін затримав би доставку сповіщень. 60 с + щонайбільше одне завантаження/розбір
 * (≤ 10 с + ≤ 8 с) на слот; решта — у наступному прогоні за 15 хв.
 */
const RUN_BUDGET_MS = 60_000;
/** `PUT` (кожен — завантаження зовнішнього URL): не більше 10 за 10 хв на користувача. */
const PUT_LIMIT = 10;
const PUT_WINDOW_SEC = 600;
const INSERT_CHUNK = 500;

type DbLike = Db | Tx;
type ImportRow = typeof calendarImports.$inferSelect;
type Deps = Pick<AppDeps, 'db' | 'env' | 'redis'> &
  Partial<Pick<AppDeps, 'realtime' | 'icsFetcher' | 'icsParser'>>;

const defaultFetcher = createIcsFetcher();
const horizon = (now: Date) => ({
  from: now.getTime(),
  to: now.getTime() + CALENDAR_IMPORT_HORIZON_DAYS * 86_400_000,
});

function toDto(
  env: AppDeps['env'],
  row: ImportRow | undefined,
  now: Date,
): CalendarImportStatusDto {
  const available = Boolean(env.CALENDAR_IMPORT_KEY);
  if (!row) {
    return {
      available,
      connected: false,
      host: null,
      lastSyncAt: null,
      lastAttemptAt: null,
      lastError: null,
      failures: 0,
      broken: false,
      eventsCount: 0,
      truncated: false,
      nextManualSyncAt: null,
    };
  }
  const next = row.lastAttemptAt ? row.lastAttemptAt.getTime() + CALENDAR_IMPORT_MANUAL_SYNC_MS : 0;
  return {
    available,
    connected: true,
    host: row.host,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastError: (row.lastError as CalendarImportErrorCode | null) ?? null,
    failures: row.failures,
    broken: row.brokenAt !== null,
    eventsCount: row.eventsCount,
    truncated: row.truncated,
    nextManualSyncAt: next > now.getTime() ? new Date(next).toISOString() : null,
  };
}

async function loadRow(db: DbLike, userId: number): Promise<ImportRow | undefined> {
  const [row] = await db.select().from(calendarImports).where(eq(calendarImports.userId, userId));
  return row;
}

async function userTimezone(db: DbLike, userId: number): Promise<string> {
  const [u] = await db.select({ tz: users.timezone }).from(users).where(eq(users.id, userId));
  return u?.tz ?? 'Europe/Kyiv';
}

/** Завантаження й розбір; помилка — `CalendarImportError` з кодом (без URL). */
async function download(deps: Deps, url: URL, tz: string, now: Date): Promise<IcsParseResult> {
  const text = await (deps.icsFetcher ?? defaultFetcher)(url);
  const { from, to } = horizon(now);
  return (deps.icsParser ?? parseIcsInWorker)({ text, from, to, fallbackTz: tz });
}

/** Атомарна заміна інтервалів користувача (усередині транзакції виклику). */
async function replaceBusy(tx: Tx, userId: number, intervals: [number, number][]): Promise<void> {
  await tx.delete(calendarImportBusy).where(eq(calendarImportBusy.userId, userId));
  for (let i = 0; i < intervals.length; i += INSERT_CHUNK) {
    await tx.insert(calendarImportBusy).values(
      intervals.slice(i, i + INSERT_CHUNK).map(([s, e]) => ({
        userId,
        startsAt: new Date(s),
        endsAt: new Date(e),
      })),
    );
  }
}

/**
 * Слот на завантаження + розбір для запиту користувача: чекаємо до `IMPORT_SLOT_WAIT_MS`, далі
 * 429 `RATE_LIMITED {retryAfterSec, reason: 'busy'}` (сервер зайнятий іншими імпортами).
 */
async function requestSlot(): Promise<() => void> {
  const release = await importSlots.acquire(IMPORT_SLOT_WAIT_MS);
  if (!release) throw new AppError(429, 'RATE_LIMITED', { retryAfterSec: 30, reason: 'busy' });
  return release;
}

// ---------- API ----------

/** `GET /api/me/calendar-import`. Посилання не повертається — лише хост. */
export async function getCalendarImport(
  deps: Deps,
  userId: number,
  now: Date = new Date(),
): Promise<CalendarImportStatusDto> {
  return toDto(deps.env, await loadRow(deps.db, userId), now);
}

async function limitPuts(deps: Deps, userId: number): Promise<void> {
  const key = `calimport:put:${userId}`;
  const n = await deps.redis.incr(key);
  if (n === 1) await deps.redis.expire(key, PUT_WINDOW_SEC);
  if (n > PUT_LIMIT) throw new AppError(429, 'RATE_LIMITED');
}

/**
 * `PUT /api/me/calendar-import {url}` — підключити або замінити посилання. Посилання
 * перевіряється (https, без приватних адрес) і одразу завантажується: невдача — 422
 * `CALENDAR_IMPORT_FAILED {reason}`, нічого не зберігається (попереднє підключення лишається).
 * Успіх — посилання зашифровано, зайнятість замінено, стан «зламано» знято.
 */
export async function putCalendarImport(
  deps: Deps,
  userId: number,
  body: unknown,
  now: Date = new Date(),
): Promise<CalendarImportStatusDto> {
  const key = importKey(deps.env);
  const { url: raw } = calendarImportInputSchema.parse(body);
  let url: URL;
  try {
    url = normalizeIcsUrl(raw);
  } catch (err) {
    if (err instanceof CalendarImportError) {
      throw new AppError(400, 'CALENDAR_IMPORT_URL_INVALID', { reason: err.reason });
    }
    throw err;
  }
  await limitPuts(deps, userId);
  const tz = await userTimezone(deps.db, userId);
  let result: IcsParseResult;
  const release = await requestSlot();
  try {
    result = await download(deps, url, tz, now);
  } catch (err) {
    if (err instanceof CalendarImportError) {
      throw new AppError(422, 'CALENDAR_IMPORT_FAILED', { reason: err.reason });
    }
    throw err;
  } finally {
    release();
  }
  const urlEnc = encryptUrl(key, userId, url.href);
  const host = literalHost(url.hostname).toLowerCase().slice(0, 255);
  await deps.db.transaction(async (tx) => {
    const values = {
      urlEnc,
      host,
      lastSyncAt: now,
      lastAttemptAt: now,
      lastError: null,
      failures: 0,
      brokenAt: null,
      eventsCount: result.occurrences,
      truncated: result.truncated,
      updatedAt: now,
    };
    await tx
      .insert(calendarImports)
      .values({ userId, createdAt: now, ...values })
      .onDuplicateKeyUpdate({ set: values });
    await replaceBusy(tx, userId, result.intervals);
  });
  return getCalendarImport(deps, userId, now);
}

/** `DELETE /api/me/calendar-import` — відключити: посилання й уся імпортована зайнятість видаляються. */
export async function deleteCalendarImport(
  deps: Pick<AppDeps, 'db'>,
  userId: number,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await deleteCalendarImportTx(tx, userId);
  });
}

/** Те саме в транзакції виклику (видалення акаунта). */
export async function deleteCalendarImportTx(tx: Tx, userId: number): Promise<void> {
  await tx.delete(calendarImportBusy).where(eq(calendarImportBusy.userId, userId));
  await tx.delete(calendarImports).where(eq(calendarImports.userId, userId));
}

/**
 * `POST /api/me/calendar-import/sync` — оновити зараз (не частіше ніж раз на 5 хв від
 * останньої спроби, інакше 429 `RATE_LIMITED {retryAfterSec}`). Працює й для «зламаного»
 * імпорту: успіх знімає позначку. Відповідь — стан (невдача видна в `lastError`).
 */
export async function syncCalendarImportNow(
  deps: Deps,
  userId: number,
  now: Date = new Date(),
): Promise<CalendarImportStatusDto> {
  const keys = importKeys(deps.env);
  const row = await loadRow(deps.db, userId);
  if (!row) throw new AppError(404, 'NOT_FOUND');
  // Слот — до «заявки»: зайнятий сервер не «з'їдає» 5-хвилинне вікно користувача.
  const release = await requestSlot();
  try {
    await claimAndSync(deps, keys, row, now);
  } finally {
    release();
  }
  return getCalendarImport(deps, userId, now);
}

async function claimAndSync(
  deps: Deps,
  keys: ImportKeys,
  row: ImportRow,
  now: Date,
): Promise<void> {
  const userId = row.userId;
  const since = new Date(now.getTime() - CALENDAR_IMPORT_MANUAL_SYNC_MS);
  // Умовний UPDATE — «заявка» на спробу: два паралельні запити не завантажать двічі.
  const [claim] = await deps.db
    .update(calendarImports)
    .set({ lastAttemptAt: now })
    .where(
      and(
        eq(calendarImports.userId, userId),
        eq(calendarImports.urlEnc, row.urlEnc),
        or(isNull(calendarImports.lastAttemptAt), lte(calendarImports.lastAttemptAt, since)),
      ),
    );
  if (claim.affectedRows === 0) {
    const last = row.lastAttemptAt?.getTime() ?? now.getTime();
    const retryAfterSec = Math.max(
      1,
      Math.ceil((last + CALENDAR_IMPORT_MANUAL_SYNC_MS - now.getTime()) / 1000),
    );
    throw new AppError(429, 'RATE_LIMITED', { retryAfterSec });
  }
  await syncOne(deps, keys, row, now);
}

// ---------- синхронізація ----------

/**
 * Одна синхронізація: розшифрувати, завантажити, розібрати; результат записується, лише якщо
 * посилання за цей час не змінили й не відключили (рядок блокується `FOR UPDATE` і
 * порівнюється `url_enc`). Невдача — `failures + 1` і код причини; на
 * `CALENDAR_IMPORT_MAX_FAILURES`-й поспіль — «зламано»: дані видаляються, власнику одне
 * сповіщення `calendar.import_broken`. Повертає код невдачі або `null`.
 */
async function syncOne(
  deps: Deps,
  keys: ImportKeys,
  row: ImportRow,
  now: Date,
): Promise<CalendarImportErrorCode | null> {
  let result: IcsParseResult | undefined;
  let reason: CalendarImportErrorCode | null = null;
  let plain: string | undefined;
  let stale = false;
  try {
    ({ url: plain, stale } = decryptWithKeys(keys, row.userId, row.urlEnc));
  } catch {
    // Пошкоджений рядок або інший ключ (ротація) — посилання не відновити.
    reason = 'invalid_url';
  }
  if (plain !== undefined) {
    try {
      const url = normalizeIcsUrl(plain);
      result = await download(deps, url, await userTimezone(deps.db, row.userId), now);
    } catch (err) {
      if (!(err instanceof CalendarImportError)) throw err;
      reason = err.reason;
    }
  }
  const created: NotificationRow[] = [];
  await deps.db.transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(calendarImports)
      .where(eq(calendarImports.userId, row.userId))
      .for('update');
    if (!cur || cur.urlEnc !== row.urlEnc) return;
    if (result) {
      await tx
        .update(calendarImports)
        .set({
          lastSyncAt: now,
          lastAttemptAt: now,
          lastError: null,
          failures: 0,
          brokenAt: null,
          eventsCount: result.occurrences,
          truncated: result.truncated,
          // Ротація ключа: розшифровано попереднім — перешифровуємо поточним.
          ...(stale ? { urlEnc: encryptUrl(keys.current, row.userId, plain!) } : {}),
          updatedAt: now,
        })
        .where(eq(calendarImports.userId, row.userId));
      await replaceBusy(tx, row.userId, result.intervals);
      return;
    }
    const failures = cur.failures + 1;
    const breaks = failures >= CALENDAR_IMPORT_MAX_FAILURES && cur.brokenAt === null;
    await tx
      .update(calendarImports)
      .set({
        lastAttemptAt: now,
        lastError: reason,
        failures,
        brokenAt: breaks ? now : cur.brokenAt,
        updatedAt: now,
      })
      .where(eq(calendarImports.userId, row.userId));
    if (!breaks) return;
    // Застарілі дані більше не вважаються календарем (підбір бачитиме «невідомо»).
    await tx.delete(calendarImportBusy).where(eq(calendarImportBusy.userId, row.userId));
    const n = await createOptionalNotification(deps, tx, {
      userId: row.userId,
      type: 'calendar.import_broken',
      category: 'schedule',
      params: {},
      entityType: null,
      entityId: null,
    });
    if (n) created.push(n);
  });
  emitNotificationsNew(deps, created);
  return reason;
}

/**
 * Джоб `schedule.calendar_import`: оновлює підключені, не «зламані» посилання активних
 * користувачів, остання спроба яких була щонайменше 3 год тому (найдавніші — першими), до
 * `SYNC_BATCH` за прогін (і не довше `RUN_BUDGET_MS`), по `SYNC_CONCURRENCY` одночасно. Повтор/перезапуск безпечні: спроба
 * пише `last_attempt_at`, тож уже оновлені в наступному прогоні не беруться. У лог — лише id
 * користувача й код причини (ніколи посилання). Без ключа шифрування — нічого не робить.
 */
export async function runCalendarImportSync(
  deps: Deps,
  now: Date,
): Promise<{ synced: number; failed: number }> {
  if (!deps.env.CALENDAR_IMPORT_KEY) return { synced: 0, failed: 0 };
  const keys = importKeys(deps.env);
  const due = new Date(now.getTime() - CALENDAR_IMPORT_SYNC_EVERY_MS);
  const rows = await deps.db
    .select({ row: calendarImports })
    .from(calendarImports)
    .innerJoin(users, eq(users.id, calendarImports.userId))
    .where(
      and(
        isNull(calendarImports.brokenAt),
        or(isNull(calendarImports.lastAttemptAt), lte(calendarImports.lastAttemptAt, due)),
        eq(users.status, 'active'),
        eq(users.isBanned, false),
      ),
    )
    .orderBy(asc(calendarImports.lastAttemptAt), asc(calendarImports.userId))
    .limit(SYNC_BATCH);
  let synced = 0;
  let failed = 0;
  let firstError: unknown;
  const queue = rows.map((r) => r.row);
  const stopAt = Date.now() + RUN_BUDGET_MS;
  const worker = async () => {
    for (let r = queue.shift(); r && Date.now() < stopAt; r = queue.shift()) {
      // Спільний із запитами користувачів ліміт процесу; джоб чекає в черзі.
      const release = (await importSlots.acquire())!;
      try {
        const reason = await syncOne(deps, keys, r, now);
        if (reason) {
          failed++;
          console.warn(`calendar import: user ${r.userId} sync failed (${reason})`);
        } else synced++;
      } catch (err) {
        failed++;
        firstError ??= err;
        console.error(
          `calendar import: user ${r.userId} sync error`,
          err instanceof Error ? err.name : 'unknown',
        );
      } finally {
        release();
      }
    }
  };
  await Promise.all(Array.from({ length: SYNC_CONCURRENCY }, worker));
  if (firstError) throw firstError;
  return { synced, failed };
}

// ---------- для підбору часу, нагадувань і пошуку ----------

/**
 * Імпортована зайнятість користувачів у `[from, to)` — два запити незалежно від кількості.
 * Ключі результату — лише ті, у кого є чинний імпорт (успішно синхронізований, не «зламаний»):
 * для них імпорт вважається календарем (`hasCalendar`), навіть якщо подій немає.
 *
 * Імпорт без тижневих слотів дає «може» лише в 09:00–24:00 поясу користувача
 * (`IMPORT_ONLY_WAKING_WINDOW`, у спільному підборі). Нагадування про порожній календар
 * (`noCalendarData`) на імпорт не зважає: без слотів воно йде й таким користувачам — з
 * текстом «додайте звичні години» (`hasImport`).
 */
export async function importedBusyForUsers(
  db: DbLike,
  userIds: readonly number[],
  from: Date,
  to: Date,
): Promise<Map<number, BusyInterval[]>> {
  const out = new Map<number, BusyInterval[]>();
  if (userIds.length === 0) return out;
  const live = await db
    .select({ userId: calendarImports.userId })
    .from(calendarImports)
    .where(
      and(
        inArray(calendarImports.userId, [...userIds]),
        isNull(calendarImports.brokenAt),
        isNotNull(calendarImports.lastSyncAt),
      ),
    );
  if (live.length === 0) return out;
  for (const l of live) out.set(l.userId, []);
  const rows = await db
    .select({
      userId: calendarImportBusy.userId,
      startsAt: calendarImportBusy.startsAt,
      endsAt: calendarImportBusy.endsAt,
    })
    .from(calendarImportBusy)
    .where(
      and(
        inArray(
          calendarImportBusy.userId,
          live.map((l) => l.userId),
        ),
        lt(calendarImportBusy.startsAt, to),
        gt(calendarImportBusy.endsAt, from),
      ),
    )
    .orderBy(asc(calendarImportBusy.startsAt));
  for (const r of rows) out.get(r.userId)!.push({ start: r.startsAt, end: r.endsAt });
  return out;
}
