/** Тривалість у годинах для підписів: українська кома, цілі без десяткових («3,5», «2»). */
export function formatHours(minutes: number): string {
  return (minutes / 60).toLocaleString('uk-UA', { maximumFractionDigits: 2 });
}
