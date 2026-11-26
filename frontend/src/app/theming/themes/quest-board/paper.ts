/** Скільки варіантів рваного обрису пергаменту (`data-paper`, маски — у quest-board.less). */
export const PAPERS = 6;

/**
 * Варіант обрису пергаменту за id гри — спільний для оголошення пошуку й «Моїх ігор»:
 * стабільний між перерисовками, а в сусідніх ігор (id підряд) — різний. Доданок `id / 6`
 * розводить обрис і остачу `id % 6`: у шести ігор підряд обриси не повторюються «смугою».
 */
export function paperVariant(id: number): number {
  const n = Math.abs(id);
  return (n + Math.floor(n / PAPERS)) % PAPERS;
}

/** Найбільший і найменший кут нахилу оголошення (°): читабельно й без зовсім рівних аркушів. */
export const MAX_TILT_DEG = 3.5;
export const MIN_TILT_DEG = 0.6;
/** Найбільший зсув оголошення вниз (px). */
export const MAX_SHIFT_PX = 8;

export interface NoticeTilt {
  /** Кут у градусах, від −MAX_TILT_DEG до MAX_TILT_DEG, за модулем не менше MIN_TILT_DEG. */
  readonly angle: number;
  /** Зсув униз у px, 0…MAX_SHIFT_PX. */
  readonly shift: number;
}

/** Перемішування 32-бітного числа (фіналізатор murmur3): близькі id дають далекі значення. */
function mix(x: number): number {
  let h = x | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * «Випадковий» нахил і зсув оголошення за id гри: виглядає хаотично, але стабільний між
 * перерисовками й сторінками (той самий аркуш не «смикається» при оновленні списку).
 * Значення округлені до 0.1° / 1px.
 */
export function noticeTilt(id: number): NoticeTilt {
  const h = mix(Math.abs(id) + 0x9e3779b9);
  const u = (h & 0xffff) / 0xffff; // 0…1 — величина кута
  const sign = h & 0x10000 ? 1 : -1;
  const v = (h >>> 17) / 0x7fff; // 0…1 — зсув
  const magnitude = MIN_TILT_DEG + u * (MAX_TILT_DEG - MIN_TILT_DEG);
  return {
    angle: Math.round(sign * magnitude * 10) / 10,
    shift: Math.round(v * MAX_SHIFT_PX),
  };
}
