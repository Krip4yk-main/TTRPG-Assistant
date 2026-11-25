import {
  APPLICATION_CANCEL_REASONS,
  APPLICATION_STATUSES,
  CONSTRAINT_RESPONSES,
  ERROR_CODES,
  SESSION_STATUSES,
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

  it('має підписи, підтвердження й результати для кожної дії майстра з учасником', () => {
    const m = uk.members as unknown as Record<string, Record<string, unknown>>;
    for (const action of ['kick', 'ban', 'blacklist']) {
      expect(m['actions']![action]).toBeTruthy();
      expect(m['done']![action]).toBeTruthy();
      expect(m['confirm']![action]).toMatchObject({
        title: expect.any(String),
        text: expect.any(String),
        confirm: expect.any(String),
      });
    }
    expect(uk.games.confirm.startBelowMin.text).toContain('Почати все одно?');
  });

  it('має підписи статусів сесій і підписи, результати для кожної дії над сесією', () => {
    const sessions = uk.sessions as unknown as Record<string, Record<string, string>>;
    expect([...SESSION_STATUSES, 'awaiting'].filter((st) => !sessions['status']![st])).toEqual([]);
    for (const action of ['reschedule', 'cancel', 'finish']) {
      expect(sessions['actions']![action]).toBeTruthy();
      expect(sessions['actionsAria']![action]).toContain('{{when}}');
      expect(sessions['done']![action]).toBeTruthy();
    }
  });
});
