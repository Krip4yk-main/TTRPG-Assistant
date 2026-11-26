import ICAL from 'ical.js';
import { CALENDAR_IMPORT_MAX_OCCURRENCES, zonedToUtc } from '@nri/shared';
import { CalendarImportError } from './errors.js';

type Component = InstanceType<typeof ICAL.Component>;
type IcalEvent = InstanceType<typeof ICAL.Event>;
type IcalTime = InstanceType<typeof ICAL.Time>;

export interface IcsParseInput {
  text: string;
  /** Горизонт `[from, to)`, мс епохи. */
  from: number;
  to: number;
  /** Пояс власника: для подій «весь день» і плаваючого часу без відомого поясу. */
  fallbackTz: string;
  maxOccurrences?: number;
  /** Скільки кроків розгортання повторів на одну подію (від її DTSTART, не від горизонту). */
  maxIterationsPerEvent?: number;
  /** Скільки кроків на весь файл. */
  maxIterations?: number;
  /** Найдовший розбір, мс — далі `too_complex`. */
  budgetMs?: number;
}

export interface IcsParseResult {
  /** Злиті інтервали зайнятості `[start, end)` у мс, обрізані горизонтом, за зростанням. */
  intervals: [number, number][];
  /** Скільки подій (повторів) у горизонті враховано. */
  occurrences: number;
  /** Досягнуто ліміту повторів/кроків — частину пропущено. */
  truncated: boolean;
}

const DAY_MS = 86_400_000;

const validZones = new Map<string, boolean>();
function isIanaZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  let ok = validZones.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      ok = true;
    } catch {
      ok = false;
    }
    if (validZones.size < 1000) validZones.set(tz, ok);
  }
  return ok;
}

const upper = (c: Component, name: string): string => {
  const v = c.getFirstPropertyValue(name);
  return typeof v === 'string' ? v.trim().toUpperCase() : '';
};

/** Подія не займає час: скасована, «прозора» (TRANSP:TRANSPARENT) або Outlook «вільний». */
function isFree(c: Component): boolean {
  return (
    upper(c, 'status') === 'CANCELLED' ||
    upper(c, 'transp') === 'TRANSPARENT' ||
    upper(c, 'x-microsoft-cdo-busystatus') === 'FREE'
  );
}

const tzidOf = (c: Component, prop: string): string | null => {
  const p = c.getFirstProperty(prop);
  const v = p?.getParameter('tzid');
  return typeof v === 'string' ? v : null;
};

/**
 * Момент у мс. UTC і пояси з VTIMEZONE файлу — як є; плаваючий час (або TZID без визначення
 * у файлі) — у поясі TZID, якщо це відомий IANA-пояс, інакше в поясі власника. Дата без часу —
 * локальна північ у тому ж поясі (подія «весь день» займає весь локальний день).
 */
function toMs(t: IcalTime, tzid: string | null, fallbackTz: string): number {
  const zone = t.zone;
  const floating = !zone || zone === ICAL.Timezone.localTimezone;
  if (!t.isDate && !floating) return t.toUnixTime() * 1000;
  const tz = isIanaZone(tzid) ? tzid : fallbackTz;
  const local = t.isDate
    ? { year: t.year, month: t.month, day: t.day, hour: 0, minute: 0 }
    : { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute };
  return zonedToUtc(local, tz).getTime() + (t.isDate ? 0 : t.second * 1000);
}

/**
 * Розбір ICS у зайнятість на горизонті. Повтори (RRULE/RDATE/EXDATE), винятки
 * (RECURRENCE-ID, зокрема RANGE=THISANDFUTURE) і пояси (VTIMEZONE) — бібліотекою ical.js.
 * Ігноруються скасовані, прозорі й «вільні» події, а також правила з частотою SECONDLY/
 * MINUTELY (у реальних календарях їх немає — лише як атака). Обмеження: не більше
 * `maxOccurrences` подій у горизонті, `maxIterationsPerEvent` кроків на подію, `maxIterations`
 * на файл (далі — `truncated`) і `budgetMs` часу (далі — `too_complex`). Назви, описи, місця,
 * учасники подій не читаються й не повертаються.
 */
export function parseIcsBusy(input: IcsParseInput): IcsParseResult {
  const maxOcc = input.maxOccurrences ?? CALENDAR_IMPORT_MAX_OCCURRENCES;
  const perEvent = input.maxIterationsPerEvent ?? 30_000;
  const maxIter = input.maxIterations ?? 300_000;
  const deadline = Date.now() + (input.budgetMs ?? 4_000);
  const { from, to, fallbackTz } = input;

  let roots: Component[];
  try {
    const jcal = ICAL.parse(input.text) as unknown[];
    const list = Array.isArray(jcal[0]) ? (jcal as unknown[][]) : [jcal];
    roots = list.map((j) => new ICAL.Component(j as never));
  } catch {
    throw new CalendarImportError('parse_failed');
  }
  if (roots.length === 0 || roots.some((r) => r.name !== 'vcalendar')) {
    throw new CalendarImportError('not_calendar');
  }

  const raw: [number, number][] = [];
  let occurrences = 0;
  let iterations = 0;
  let truncated = false;
  const full = () => occurrences >= maxOcc;

  /** Додає інтервал (обрізаний горизонтом); `false` — ліміт подій вичерпано. */
  const add = (start: number, end: number): boolean => {
    if (!(end > start) || end <= from || start >= to) return true;
    if (full()) {
      truncated = true;
      return false;
    }
    occurrences++;
    raw.push([Math.max(start, from), Math.min(end, to)]);
    return true;
  };

  const tick = () => {
    iterations++;
    if ((iterations & 1023) === 0 && Date.now() > deadline) {
      throw new CalendarImportError('too_complex');
    }
  };

  /** Одна (не повторювана) подія або окремий виняток серії. */
  const single = (c: Component): boolean => {
    if (isFree(c)) return true;
    let ev: IcalEvent;
    try {
      ev = new ICAL.Event(c);
    } catch {
      return true;
    }
    const s = ev.startDate;
    if (!s) return true;
    const e = ev.endDate;
    const start = toMs(s, tzidOf(c, 'dtstart'), fallbackTz);
    let end = toMs(e, tzidOf(c, 'dtend') ?? tzidOf(c, 'dtstart'), fallbackTz);
    if (s.isDate && end <= start) end = start + DAY_MS;
    return add(start, end);
  };

  outer: for (const root of roots) {
    const vevents = root.getAllSubcomponents('vevent');
    const masters = new Map<string, Component>();
    const exceptions = new Map<string, Component[]>();
    const standalone: Component[] = [];
    for (const c of vevents) {
      const uid = c.getFirstPropertyValue('uid');
      const key = typeof uid === 'string' && uid ? uid : null;
      const isException = c.hasProperty('recurrence-id');
      if (!key) {
        standalone.push(c);
      } else if (isException) {
        const list = exceptions.get(key) ?? [];
        list.push(c);
        exceptions.set(key, list);
      } else if (masters.has(key)) {
        standalone.push(c);
      } else {
        masters.set(key, c);
      }
    }

    for (const c of standalone) {
      tick();
      if (!single(c)) break outer;
    }

    for (const [uid, master] of masters) {
      const excs = exceptions.get(uid) ?? [];
      exceptions.delete(uid);
      // Скасована серія — скасовано всі її повтори (включно з перенесеними).
      if (upper(master, 'status') === 'CANCELLED') continue;
      let ev: IcalEvent;
      try {
        ev = new ICAL.Event(master, { strictExceptions: true });
        for (const x of excs) {
          try {
            ev.relateException(x);
          } catch {
            // Виняток без коректного RECURRENCE-ID — як окрема подія.
            tick();
            if (!single(x)) break outer;
          }
        }
      } catch {
        continue;
      }
      if (!ev.startDate) continue;
      if (!ev.isRecurring()) {
        tick();
        if (!single(master)) break outer;
        continue;
      }
      const rules = master
        .getAllProperties('rrule')
        .map((p) => p.getFirstValue() as { freq?: string });
      if (rules.some((r) => r.freq === 'SECONDLY' || r.freq === 'MINUTELY')) continue;

      // Прямі винятки (перенесені/змінені повтори) — окремими подіями, у своєму часі.
      const direct = new Set<string>();
      for (const x of Object.values(ev.exceptions) as IcalEvent[]) {
        if (x.modifiesFuture()) continue;
        direct.add(x.recurrenceId.toString());
        direct.add(x.recurrenceId.convertToZone(ICAL.Timezone.utcTimezone).toString());
        tick();
        if (!single(x.component)) break outer;
      }

      const it = ev.iterator();
      let steps = 0;
      for (;;) {
        if (iterations >= maxIter || steps >= perEvent) {
          truncated = true;
          break;
        }
        tick();
        steps++;
        const next = it.next();
        if (!next) break;
        const id = next.toString();
        if (
          direct.has(id) ||
          direct.has(next.convertToZone(ICAL.Timezone.utcTimezone).toString())
        ) {
          continue;
        }
        const d = ev.getOccurrenceDetails(next);
        const item = d.item.component;
        const tzStart = tzidOf(item, 'dtstart');
        const start = toMs(d.startDate, tzStart, fallbackTz);
        if (start >= to) break;
        if (isFree(item)) continue;
        let end = toMs(d.endDate, tzidOf(item, 'dtend') ?? tzStart, fallbackTz);
        if (d.startDate.isDate && end <= start) end = start + DAY_MS;
        if (!add(start, end)) break outer;
      }
    }

    // Винятки без основної події серії — окремі події.
    for (const list of exceptions.values()) {
      for (const x of list) {
        tick();
        if (!single(x)) break outer;
      }
    }
  }

  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const intervals: [number, number][] = [];
  for (const [s, e] of raw) {
    const last = intervals[intervals.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else intervals.push([s, e]);
  }
  return { intervals, occurrences, truncated };
}
