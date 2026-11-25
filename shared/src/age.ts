export const MIN_REGISTRATION_AGE = 14;
export const BIRTH_DATE_CHANGE_COOLDOWN_DAYS = 30;

export type AgeRating = 'none' | '16+' | '18+' | '21+';

const REQUIRED_AGE: Record<AgeRating, number> = { none: 0, '16+': 16, '18+': 18, '21+': 21 };

function parse(date: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date (expected YYYY-MM-DD): ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Повних років на дату `today`; обидві дати — YYYY-MM-DD, без часових поясів. */
export function ageOn(birthDate: string, today: string): number {
  const [by, bm, bd0] = parse(birthDate);
  const [ty, tm, td] = parse(today);
  // 29 лютого в невисокосний рік вважається 28 лютого.
  const bd = bm === 2 && bd0 === 29 && !isLeap(ty) ? 28 : bd0;
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age;
}

export function canRegister(birthDate: string, today: string): boolean {
  return ageOn(birthDate, today) >= MIN_REGISTRATION_AGE;
}

/** `null` (гість) проходить лише `'none'`. */
export function meetsAgeRating(age: number | null, rating: AgeRating): boolean {
  if (rating === 'none') return true;
  return age !== null && age >= REQUIRED_AGE[rating];
}
