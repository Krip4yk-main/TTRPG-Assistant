/** Безпечний шлях повернення: лише внутрішній, не сторінка входу. */
export function safeReturnTo(url: string | null | undefined): string | null {
  if (!url || !url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) return null;
  if (url === '/' || url.startsWith('/login')) return null;
  return url;
}
