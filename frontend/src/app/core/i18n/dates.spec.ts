import { weeklyInZone } from './dates';

describe('weeklyInZone', () => {
  // Пн 1 бер. 2027, 19:00 за Києвом (UTC+2) = 17:00 UTC.
  const startsAt = '2027-03-01T17:00:00.000Z';
  const now = new Date(startsAt);

  it('у тому ж поясі — ті самі дні й час', () => {
    expect(weeklyInZone(startsAt, 'Europe/Kyiv', [0, 3], 'Europe/Kyiv', now)).toEqual({
      weekdays: [0, 3],
      time: '19:00',
    });
  });

  it('в іншому поясі — час переведено, день лишається, якщо не перейшов північ', () => {
    expect(weeklyInZone(startsAt, 'Europe/Kyiv', [0, 3], 'Europe/Warsaw', now)).toEqual({
      weekdays: [0, 3],
      time: '18:00',
    });
  });

  it('якщо сесія в поясі глядача переходить північ — дні зсуваються', () => {
    // 19:00 Київ = 02:00 наступного дня в Токіо (UTC+9).
    expect(weeklyInZone(startsAt, 'Europe/Kyiv', [0, 6], 'Asia/Tokyo', now)).toEqual({
      weekdays: [0, 1],
      time: '02:00',
    });
  });

  it('літній час — за поточною датою, а не за першою сесією', () => {
    // Перша сесія взимку (19:00 Київ = 17:00 UTC), а «зараз» — липень: 19:00 Київ = 16:00 UTC
    // = 01:00 наступного дня в Токіо (без літнього часу).
    const july = new Date('2027-07-05T09:00:00.000Z');
    expect(weeklyInZone(startsAt, 'Europe/Kyiv', [0], 'Asia/Tokyo', july)).toEqual({
      weekdays: [1],
      time: '01:00',
    });
  });
});
