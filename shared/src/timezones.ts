/**
 * Пояси, які не можна обрати: названі за містами Росії (включно з псевдонімами IANA).
 * Час у них показати можна (напр. гостю з браузером у такому поясі), але обрати чи
 * зберегти — ні. `Europe/Simferopol` (Крим — Україна) і `Europe/Minsk` не блокуються.
 */
export const BLOCKED_TIMEZONES: ReadonlySet<string> = new Set([
  'Europe/Moscow',
  'W-SU',
  'Europe/Kaliningrad',
  'Europe/Kirov',
  'Europe/Samara',
  'Europe/Volgograd',
  'Europe/Saratov',
  'Europe/Ulyanovsk',
  'Europe/Astrakhan',
  'Asia/Yekaterinburg',
  'Asia/Omsk',
  'Asia/Novosibirsk',
  'Asia/Barnaul',
  'Asia/Tomsk',
  'Asia/Novokuznetsk',
  'Asia/Krasnoyarsk',
  'Asia/Irkutsk',
  'Asia/Chita',
  'Asia/Yakutsk',
  'Asia/Khandyga',
  'Asia/Vladivostok',
  'Asia/Ust-Nera',
  'Asia/Magadan',
  'Asia/Sakhalin',
  'Asia/Srednekolymsk',
  'Asia/Kamchatka',
  'Asia/Anadyr',
]);

/** Пояс за замовчуванням і на заміну заблокованому. */
export const DEFAULT_TIMEZONE = 'Europe/Kyiv';

/** Застарілі назви → правильні (`Europe/Kiev` — російська транслітерація). */
const RENAMED: Readonly<Record<string, string>> = { 'Europe/Kiev': 'Europe/Kyiv' };

/** Правильна назва поясу: `Europe/Kiev` → `Europe/Kyiv`, решта — без змін. */
export function normalizeTimezone(tz: string): string {
  return RENAMED[tz] ?? tz;
}

/** Як пояс розуміє `Intl` (псевдоніми розгорнуті); `null` — пояс невідомий. */
function resolvedZone(tz: string): string | null {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

let byLowerCase: Map<string, string> | null = null;

/** Написання поясу з переліку `Intl` без урахування регістру (`europe/warsaw` → `Europe/Warsaw`). */
function properCase(tz: string): string {
  if (!byLowerCase) {
    byLowerCase = new Map();
    try {
      for (const name of Intl.supportedValuesOf('timeZone'))
        byLowerCase.set(name.toLowerCase(), name);
    } catch {
      // Немає переліку — лишаємо написання як є.
    }
  }
  return byLowerCase.get(tz.toLowerCase()) ?? tz;
}

/**
 * Назва поясу для збереження: правильний регістр (`europe/warsaw` → `Europe/Warsaw`) і
 * правильні назви (`Europe/Kyiv`); `null` — пояс невідомий. Інші назви не переписуються
 * (`Asia/Kolkata` лишається `Asia/Kolkata`, хоч рушій може знати її як `Asia/Calcutta`).
 */
export function canonicalTimezone(tz: string): string | null {
  return resolvedZone(tz) === null ? null : normalizeTimezone(properCase(tz));
}

/** Чи заблокований пояс для вибору (будь-яке написання й псевдоніми, напр. `W-SU`). */
export function isBlockedTimezone(tz: string): boolean {
  const resolved = resolvedZone(tz);
  return (
    BLOCKED_TIMEZONES.has(canonicalTimezone(tz) ?? normalizeTimezone(tz)) ||
    (resolved !== null && BLOCKED_TIMEZONES.has(resolved))
  );
}

/**
 * Список поясів для вибору з довільного джерела (напр. `Intl.supportedValuesOf`): назви
 * нормалізовані, без заблокованих і дублікатів, порядок джерела збережено.
 */
export function selectableTimezones(source: readonly string[]): string[] {
  const out = new Set<string>();
  for (const tz of source) {
    const name = normalizeTimezone(tz);
    if (!BLOCKED_TIMEZONES.has(name)) out.add(name);
  }
  return [...out];
}

/** Пояс для підстановки за замовчуванням: нормалізований, а заблокований → `Europe/Kyiv`. */
export function safeDefaultTimezone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TIMEZONE;
  return isBlockedTimezone(tz) ? DEFAULT_TIMEZONE : (canonicalTimezone(tz) ?? DEFAULT_TIMEZONE);
}
