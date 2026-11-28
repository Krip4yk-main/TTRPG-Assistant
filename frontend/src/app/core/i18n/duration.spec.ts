import { formatHours } from './duration';

describe('formatHours', () => {
  it('uses a comma decimal separator', () => {
    expect(formatHours(210)).toBe('3,5');
  });

  it('shows integers without decimals', () => {
    expect(formatHours(120)).toBe('2');
  });

  it('rounds to two decimals', () => {
    expect(formatHours(100)).toBe('1,67');
  });
});
