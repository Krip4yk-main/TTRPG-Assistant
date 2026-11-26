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

/** Чи заблокований пояс для вибору (з урахуванням нормалізації назви). */
export function isBlockedTimezone(tz: string): boolean {
  return BLOCKED_TIMEZONES.has(normalizeTimezone(tz));
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
  const name = normalizeTimezone(tz);
  return BLOCKED_TIMEZONES.has(name) ? DEFAULT_TIMEZONE : name;
}
