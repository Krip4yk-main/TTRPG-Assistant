import { z } from 'zod';

/**
 * Інструменти безпеки гри (необов'язковий множинний вибір майстра). Підписи й пояснення — у
 * `uk.json` фронтенду.
 * - `x_card` — X-Card;
 * - `session_zero` — сесія нуль (обговорення очікувань);
 * - `open_door` — можна вийти з гри будь-коли без пояснень;
 * - `check_ins` — майстер періодично питає, чи всім комфортно;
 * - `script_change` — пауза / перемотка / пропуск сцени.
 */
export const SAFETY_TOOLS = [
  'x_card',
  'session_zero',
  'open_door',
  'check_ins',
  'script_change',
] as const;
export type SafetyTool = (typeof SAFETY_TOOLS)[number];

/** Найбільше власних формулювань у списку меж чи завіс. */
export const SAFETY_CUSTOM_MAX = 10;
/** Найдовше власне формулювання межі чи завіси. */
export const SAFETY_CUSTOM_LENGTH = 100;
/** Найбільше тем каталогу (`content_warnings`) у списку меж чи завіс. */
export const SAFETY_WARNINGS_MAX = 30;

/** Ключ порівняння власних формулювань: без урахування регістру. */
export const safetyTextKey = (s: string): string => s.toLocaleLowerCase('uk');

/** Унікальні тексти (без урахування регістру), у порядку першої появи. */
function uniqueTexts(xs: string[]): string[] {
  const seen = new Set<string>();
  return xs.filter((s) => {
    const k = safetyTextKey(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Інструменти без повторів, у порядку `SAFETY_TOOLS`. */
export const safetyToolsSchema = z
  .array(z.enum(SAFETY_TOOLS))
  .max(SAFETY_TOOLS.length)
  .transform((ts) => SAFETY_TOOLS.filter((t) => ts.includes(t)));

/**
 * Межі (lines — тем у грі не буде) чи завіси (veils — теми лише «за кадром»): теми з каталогу
 * попереджень про контент (id без повторів, за зростанням) і власні формулювання (обрізані,
 * без повторів без урахування регістру).
 */
export const safetyListSchema = z
  .object({
    warningIds: z
      .array(z.number().int().positive())
      .max(SAFETY_WARNINGS_MAX)
      .default([])
      .transform((ids) => [...new Set(ids)].sort((a, b) => a - b)),
    custom: z
      .array(z.string().trim().min(1).max(SAFETY_CUSTOM_LENGTH))
      .max(SAFETY_CUSTOM_MAX)
      .default([])
      .transform(uniqueTexts),
  })
  .strict();
export type SafetyList = z.output<typeof safetyListSchema>;

export const emptySafetyList = (): SafetyList => ({ warningIds: [], custom: [] });

/** Чи заповнив майстер хоч щось із безпеки гри (інструмент, межу чи завісу). */
export function hasSafetyInfo(g: {
  safetyTools: readonly SafetyTool[];
  lines: SafetyList;
  veils: SafetyList;
}): boolean {
  return (
    g.safetyTools.length > 0 ||
    g.lines.warningIds.length + g.lines.custom.length > 0 ||
    g.veils.warningIds.length + g.veils.custom.length > 0
  );
}

/** Теми, що водночас і межа, і завіса (id каталогу та власні тексти без урахування регістру). */
export function safetyOverlap(
  lines: SafetyList,
  veils: SafetyList,
): { warningIds: number[]; custom: string[] } {
  const customKeys = new Set(lines.custom.map(safetyTextKey));
  return {
    warningIds: veils.warningIds.filter((id) => lines.warningIds.includes(id)),
    custom: veils.custom.filter((s) => customKeys.has(safetyTextKey(s))),
  };
}
