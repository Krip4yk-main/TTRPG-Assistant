import { ERROR_CODES } from '@nri/shared';
import uk from '../../../assets/i18n/uk.json';

describe('uk.json', () => {
  it('має переклад для кожного коду помилки API', () => {
    const errors = uk.errors as Record<string, string>;
    const missing = ERROR_CODES.filter((code) => !errors[code]);
    expect(missing).toEqual([]);
  });

  it('має ключ «Видалений користувач»', () => {
    expect(uk.user.deleted).toBe('Видалений користувач');
  });
});
