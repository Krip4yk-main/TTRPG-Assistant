/**
 * Мінімальний генератор iCalendar (RFC 5545) для фіду «мої сесії»: екранування TEXT,
 * фолдинг рядків за октетами UTF-8 (не розриваючи символів), CRLF.
 */

const CRLF = '\r\n';
const MAX_OCTETS = 75;

/** Екранування значення типу TEXT: `\\`, `\;`, `\,`, перенос рядка → `\n`. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Фолдинг логічного рядка: фізичні рядки ≤ 75 октетів, продовження — з пробілу (він теж
 * рахується). Ріже лише між кодовими точками, тож багатобайтні символи лишаються цілими.
 */
export function foldIcsLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= MAX_OCTETS) return line;
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (size + n > MAX_OCTETS) {
      parts.push(current);
      current = ' ';
      size = 1;
    }
    current += ch;
    size += n;
  }
  parts.push(current);
  return parts.join(CRLF);
}

/** `Date` → `YYYYMMDDTHHMMSSZ` (UTC, без мілісекунд). */
export function icsUtc(d: Date): string {
  return d
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
}

export interface IcsEvent {
  uid: string;
  start: Date;
  end: Date;
  sequence: number;
  lastModified: Date;
  summary: string;
  status: 'CONFIRMED' | 'CANCELLED';
  url: string;
  description: string;
  location: string | null;
}

/** Повний VCALENDAR з подіями; рядки складено з CRLF, кожен логічний рядок — зфолджений. */
export function renderIcsCalendar(name: string, events: IcsEvent[], now: Date): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NRI Assistant//Sessions feed//UK',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(name)}`,
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ];
  const stamp = icsUtc(now);
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsUtc(e.start)}`,
      `DTEND:${icsUtc(e.end)}`,
      `SEQUENCE:${e.sequence}`,
      `LAST-MODIFIED:${icsUtc(e.lastModified)}`,
      `SUMMARY:${escapeIcsText(e.summary)}`,
      `STATUS:${e.status}`,
      `URL:${e.url}`,
      `DESCRIPTION:${escapeIcsText(e.description)}`,
    );
    if (e.location) lines.push(`LOCATION:${escapeIcsText(e.location)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join(CRLF) + CRLF;
}
