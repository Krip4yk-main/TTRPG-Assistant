import {
  APPLICATION_CANCEL_REASONS,
  APPLICATION_STATUSES,
  CONSTRAINT_RESPONSES,
  ERROR_CODES,
} from '@nri/shared';
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

  it('має підписи статусів заявок, причин скасування й відповідей на обмеження', () => {
    const a = uk.games.applications as unknown as Record<string, Record<string, string>>;
    expect(APPLICATION_STATUSES.filter((s) => !a['status']![s] || !a['statusGroup']![s])).toEqual(
      [],
    );
    expect(APPLICATION_CANCEL_REASONS.filter((r) => !a['cancelReason']![r])).toEqual([]);
    expect([...CONSTRAINT_RESPONSES, 'none'].filter((r) => !a['constraintResponse']![r])).toEqual(
      [],
    );
  });
});
