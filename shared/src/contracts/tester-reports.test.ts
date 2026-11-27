import { describe, expect, it } from 'vitest';
import {
  TESTER_REPORT_TEXT_MAX,
  stripReportUrlSecrets,
  testerReportInputSchema,
  testerReportsQuerySchema,
} from './tester-reports.js';

const context = {
  url: 'https://dev.nri.example/games/5',
  theme: 'quest-board',
  viewportWidth: 1280,
  viewportHeight: 720,
  userAgent: 'Mozilla/5.0',
};

describe('tester report contracts', () => {
  it('input: kind from the list, trimmed non-empty text up to the limit, strict context', () => {
    expect(testerReportInputSchema.parse({ kind: 'bug', text: '  Не працює  ', context })).toEqual({
      kind: 'bug',
      text: 'Не працює',
      context,
    });
    const bad = [
      { kind: 'praise', text: 'x', context },
      { kind: 'idea', text: '   ', context },
      { kind: 'idea', text: 'x'.repeat(TESTER_REPORT_TEXT_MAX + 1), context },
      { kind: 'idea', text: 'x', context: { ...context, extra: 1 } },
      { kind: 'idea', text: 'x', context: { ...context, viewportWidth: 1.5 } },
      { kind: 'idea', text: 'x', context, userId: 'abc' },
    ];
    for (const b of bad) expect(testerReportInputSchema.safeParse(b).success).toBe(false);
    expect(
      testerReportInputSchema.safeParse({
        kind: 'other',
        text: 'x'.repeat(TESTER_REPORT_TEXT_MAX),
        context,
      }).success,
    ).toBe(true);
  });

  it('query: optional status, empty cursor as absent, default limit', () => {
    expect(testerReportsQuerySchema.parse({ status: '', cursor: '' })).toEqual({ limit: 20 });
    expect(testerReportsQuerySchema.parse({ status: 'processed', cursor: '7' })).toEqual({
      status: 'processed',
      cursor: 7,
      limit: 20,
    });
    expect(testerReportsQuerySchema.safeParse({ status: 'done' }).success).toBe(false);
  });

  it('url: drops token/code params and the fragment, keeps path and other params', () => {
    expect(
      stripReportUrlSecrets('https://dev.nri.example/login/cb?code=abc&next=%2Fgames&token=t#x=1'),
    ).toBe('https://dev.nri.example/login/cb?next=%2Fgames');
    expect(stripReportUrlSecrets('https://dev.nri.example/games?q=1')).toBe(
      'https://dev.nri.example/games?q=1',
    );
    expect(stripReportUrlSecrets('https://dev.nri.example/auth?TOKEN=1&%63ode=2')).toBe(
      'https://dev.nri.example/auth',
    );
    expect(stripReportUrlSecrets('not a url')).toBe('not a url');
  });

  it('url: drops OAuth tokens/state, keys, secrets, passwords and hashes too', () => {
    expect(
      stripReportUrlSecrets(
        'https://dev.nri.example/cb?access_token=a&ID_TOKEN=b&refresh_token=c&state=s&page=2' +
          '&key=k&secret=x&password=p&hash=h&tab=info',
      ),
    ).toBe('https://dev.nri.example/cb?page=2&tab=info');
    // Схожі, але інші назви лишаються.
    expect(stripReportUrlSecrets('https://dev.nri.example/x?keyword=a&statement=b')).toBe(
      'https://dev.nri.example/x?keyword=a&statement=b',
    );
  });
});
