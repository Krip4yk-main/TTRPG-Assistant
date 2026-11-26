import { describe, expect, it } from 'vitest';
import { CalendarImportError } from '../../src/scheduling/ical/errors.js';
import { parseIcsBusy, type IcsParseInput } from '../../src/scheduling/ical/ics-parse.js';
import { parseIcsInWorker } from '../../src/scheduling/ical/parse-runner.js';

const FROM = Date.parse('2027-01-04T00:00:00Z'); // понеділок
const TO = FROM + 56 * 86_400_000;
const KYIV = 'Europe/Kyiv'; // узимку UTC+2

const cal = (...events: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...events, 'END:VCALENDAR'].join('\r\n');
const ev = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');

const parse = (text: string, extra: Partial<IcsParseInput> = {}) =>
  parseIcsBusy({ text, from: FROM, to: TO, fallbackTz: KYIV, ...extra });
const iso = (r: { intervals: [number, number][] }) =>
  r.intervals.map(([s, e]) => [new Date(s).toISOString(), new Date(e).toISOString()]);

const VTZ_KYIV = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Kyiv',
  'BEGIN:STANDARD',
  'DTSTART:19701025T040000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'TZOFFSETFROM:+0300',
  'TZOFFSETTO:+0200',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:19700329T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0300',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
].join('\r\n');

describe('ICS parsing into busy intervals (RF 3)', () => {
  it('UTC, VTIMEZONE, IANA TZID without definition and floating time', () => {
    const r = parse(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        VTZ_KYIV,
        ev('UID:a', 'DTSTART:20270105T100000Z', 'DTEND:20270105T110000Z', 'SUMMARY:Секрет'),
        ev(
          'UID:b',
          'DTSTART;TZID=Europe/Kyiv:20270106T190000',
          'DTEND;TZID=Europe/Kyiv:20270106T200000',
        ),
        ev('UID:c', 'DTSTART;TZID=America/New_York:20270107T090000', 'DURATION:PT30M'),
        ev('UID:d', 'DTSTART:20270108T120000', 'DTEND:20270108T130000'),
        'END:VCALENDAR',
      ].join('\r\n'),
    );
    expect(iso(r)).toEqual([
      ['2027-01-05T10:00:00.000Z', '2027-01-05T11:00:00.000Z'],
      ['2027-01-06T17:00:00.000Z', '2027-01-06T18:00:00.000Z'],
      ['2027-01-07T14:00:00.000Z', '2027-01-07T14:30:00.000Z'],
      // плаваючий час — у поясі власника (Kyiv, UTC+2)
      ['2027-01-08T10:00:00.000Z', '2027-01-08T11:00:00.000Z'],
    ]);
    expect(r.occurrences).toBe(4);
    expect(JSON.stringify(r)).not.toContain('Секрет');
  });

  it('all-day events cover the whole local day in the owner zone (multi-day too)', () => {
    const r = parse(
      cal(
        ev('UID:a', 'DTSTART;VALUE=DATE:20270110'),
        ev('UID:b', 'DTSTART;VALUE=DATE:20270115', 'DTEND;VALUE=DATE:20270118'),
      ),
      { fallbackTz: 'Europe/Warsaw' },
    );
    expect(iso(r)).toEqual([
      ['2027-01-09T23:00:00.000Z', '2027-01-10T23:00:00.000Z'],
      ['2027-01-14T23:00:00.000Z', '2027-01-17T23:00:00.000Z'],
    ]);
  });

  it('transparent, cancelled and Outlook «free» events are ignored', () => {
    const r = parse(
      cal(
        ev('UID:a', 'DTSTART:20270105T100000Z', 'DTEND:20270105T110000Z', 'TRANSP:TRANSPARENT'),
        ev('UID:b', 'DTSTART:20270106T100000Z', 'DTEND:20270106T110000Z', 'STATUS:CANCELLED'),
        ev(
          'UID:c',
          'DTSTART:20270107T100000Z',
          'DTEND:20270107T110000Z',
          'X-MICROSOFT-CDO-BUSYSTATUS:FREE',
        ),
        ev('UID:d', 'DTSTART:20270108T100000Z', 'DTEND:20270108T110000Z', 'TRANSP:OPAQUE'),
        // скасована серія — жодного повтору
        ev(
          'UID:e',
          'DTSTART:20270104T080000Z',
          'DTEND:20270104T090000Z',
          'RRULE:FREQ=DAILY',
          'STATUS:CANCELLED',
        ),
      ),
    );
    expect(iso(r)).toEqual([['2027-01-08T10:00:00.000Z', '2027-01-08T11:00:00.000Z']]);
  });

  it('RRULE with EXDATE, a moved and a cancelled instance (RECURRENCE-ID)', () => {
    const r = parse(
      cal(
        ev(
          'UID:w',
          'DTSTART:20270105T170000Z',
          'DTEND:20270105T180000Z',
          'RRULE:FREQ=WEEKLY;COUNT=4',
          'EXDATE:20270112T170000Z',
        ),
        // 19.01 перенесено на 20.01 10:00
        ev(
          'UID:w',
          'RECURRENCE-ID:20270119T170000Z',
          'DTSTART:20270120T100000Z',
          'DTEND:20270120T120000Z',
        ),
        // 26.01 скасовано
        ev(
          'UID:w',
          'RECURRENCE-ID:20270126T170000Z',
          'DTSTART:20270126T170000Z',
          'DTEND:20270126T180000Z',
          'STATUS:CANCELLED',
        ),
      ),
    );
    expect(iso(r)).toEqual([
      ['2027-01-05T17:00:00.000Z', '2027-01-05T18:00:00.000Z'],
      ['2027-01-20T10:00:00.000Z', '2027-01-20T12:00:00.000Z'],
    ]);
  });

  it('a series started years ago reaches the horizon; recurrence keeps local time over DST', () => {
    const r = parse(
      [
        'BEGIN:VCALENDAR',
        VTZ_KYIV,
        ev(
          'UID:old',
          'DTSTART;TZID=Europe/Kyiv:20150302T190000',
          'DTEND;TZID=Europe/Kyiv:20150302T200000',
          'RRULE:FREQ=WEEKLY;BYDAY=MO',
        ),
        'END:VCALENDAR',
      ].join('\r\n'),
      { to: Date.parse('2027-04-06T00:00:00Z') },
    );
    const list = iso(r);
    expect(list[0]).toEqual(['2027-01-04T17:00:00.000Z', '2027-01-04T18:00:00.000Z']);
    // 5 квітня 2027 — уже літній час (UTC+3): 19:00 Kyiv = 16:00 UTC
    expect(list.at(-1)).toEqual(['2027-04-05T16:00:00.000Z', '2027-04-05T17:00:00.000Z']);
    expect(r.truncated).toBe(false);
  });

  it('expansion caps: occurrences, iterations; SECONDLY/MINUTELY rules ignored (no hang)', () => {
    const daily = cal(
      ev('UID:d', 'DTSTART:20270104T080000Z', 'DTEND:20270104T083000Z', 'RRULE:FREQ=DAILY'),
    );
    const capped = parse(daily, { maxOccurrences: 10 });
    expect(capped.occurrences).toBe(10);
    expect(capped.truncated).toBe(true);

    // Нескінченне погодинне правило з 1970 р.: обмеження кроків, а не зависання.
    const t0 = Date.now();
    const hourly = parse(
      cal(ev('UID:h', 'DTSTART:19700101T000000Z', 'DURATION:PT10M', 'RRULE:FREQ=HOURLY')),
      { maxIterationsPerEvent: 5_000 },
    );
    expect(hourly.truncated).toBe(true);
    expect(hourly.occurrences).toBe(0);
    const secondly = parse(
      cal(
        ev('UID:s', 'DTSTART:20270104T000000Z', 'DURATION:PT1S', 'RRULE:FREQ=SECONDLY'),
        ev('UID:m', 'DTSTART:20270104T000000Z', 'DURATION:PT1M', 'RRULE:FREQ=MINUTELY'),
      ),
    );
    expect(secondly.occurrences).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5_000);

    // Багато подій — не більше ліміту за замовчуванням (2000), злиті інтервали.
    const many = parse(
      cal(
        ...Array.from({ length: 30 }, (_, i) =>
          ev(
            `UID:x${i}`,
            `DTSTART:20270104T${String(i % 24).padStart(2, '0')}0000Z`,
            'DURATION:PT20M',
            'RRULE:FREQ=HOURLY',
          ),
        ),
      ),
    );
    expect(many.occurrences).toBe(2000);
    expect(many.truncated).toBe(true);
  });

  it('time budget → too_complex; garbage → parse_failed / not_calendar', () => {
    const big = cal(
      ...Array.from({ length: 50 }, (_, i) =>
        ev(`UID:y${i}`, 'DTSTART:19700101T000000Z', 'DURATION:PT10M', 'RRULE:FREQ=HOURLY'),
      ),
    );
    expect(() => parse(big, { budgetMs: 1, maxOccurrences: 1 })).toThrow(CalendarImportError);
    try {
      parse(big, { budgetMs: 1 });
    } catch (err) {
      expect((err as CalendarImportError).reason).toBe('too_complex');
    }
    expect(() => parse('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n')).toThrow(CalendarImportError);
    try {
      parse('BEGIN:VCARD\r\nVERSION:4.0\r\nEND:VCARD');
    } catch (err) {
      expect((err as CalendarImportError).reason).toBe('not_calendar');
    }
  });

  it('runs in a worker thread with the same result', async () => {
    const text = cal(ev('UID:a', 'DTSTART:20270105T100000Z', 'DTEND:20270105T110000Z'));
    const r = await parseIcsInWorker({ text, from: FROM, to: TO, fallbackTz: KYIV });
    expect(r).toEqual(parse(text));
    await expect(
      parseIcsInWorker({ text: 'garbage', from: FROM, to: TO, fallbackTz: KYIV }),
    ).rejects.toMatchObject({ reason: 'parse_failed' });
  });
});
