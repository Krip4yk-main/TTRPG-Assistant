/** Найбільша довжина короткого опису (символів разом із «…»): meta description і картки ігор. */
export const MAX_DESCRIPTION = 200;

/**
 * Короткий опис одним рядком: переноси й повтори пробілів — один пробіл; довший за `max`
 * обрізається по межі слова з «…». Рахуються кодові точки (емодзі не розриваються).
 */
export function truncateDescription(text: string, max = MAX_DESCRIPTION): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if ([...flat].length <= max) return flat;
  let cut = [...flat].slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  if (space > 0) cut = cut.slice(0, space);
  return `${cut.replace(/[\s,.;:!?-]+$/u, '')}…`;
}
