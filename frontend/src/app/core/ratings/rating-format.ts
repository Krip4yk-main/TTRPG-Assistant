const ratingFormat = new Intl.NumberFormat('uk-UA', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const plural = new Intl.PluralRules('uk-UA');

/** Рейтинг для показу: один знак після коми (`4,6`). */
export function formatRating(value: number): string {
  return ratingFormat.format(value);
}

/** Ключ i18n для кількості оцінок з правильною формою (`ratings.units.many` → «12 оцінок»). */
export function unitsKey(n: number): string {
  return `ratings.units.${plural.select(n)}`;
}

/** Короткий день (`12 груд.`) у поясі `timeZone` — для «до 12 груд.». */
export function formatDay(iso: string, timeZone: string): string {
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  try {
    return new Intl.DateTimeFormat('uk-UA', { ...opts, timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('uk-UA', opts).format(new Date(iso));
  }
}
