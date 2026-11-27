import type { CommonTimesDto, PollDto, SessionAlternativesDto, SessionDto } from '@nri/shared';

/** Тестові дані спільного часу (лише для spec-файлів). */

export const participants: CommonTimesDto['participants'] = [
  { userId: 1, nickname: 'Майстер', isGm: true, hasCalendar: true },
  { userId: 2, nickname: 'Аня', isGm: false, hasCalendar: true },
  { userId: 3, nickname: 'Богдан', isGm: false, hasCalendar: false },
];

export function commonTimes(patch: Partial<CommonTimesDto> = {}): CommonTimesDto {
  return {
    timezone: 'Europe/Kyiv',
    durationMinutes: 240,
    from: '2030-03-01T00:00:00.000Z',
    to: '2030-03-29T00:00:00.000Z',
    participants,
    noCalendars: false,
    regular: [
      {
        weekday: 4,
        startMin: 1140,
        weeks: 4,
        firstStartsAt: '2030-03-01T17:00:00.000Z',
        can: 2,
        cannot: 0,
        unknown: 1,
        statuses: [
          { userId: 1, status: 'can', weeksCan: 4, outsideSlotsWeeks: 0 },
          { userId: 2, status: 'can', weeksCan: 3, outsideSlotsWeeks: 1 },
          { userId: 3, status: 'unknown', weeksCan: 0, outsideSlotsWeeks: 0 },
        ],
      },
      {
        weekday: 5,
        startMin: 1080,
        weeks: 4,
        firstStartsAt: '2030-03-02T16:00:00.000Z',
        can: 1,
        cannot: 1,
        unknown: 1,
        statuses: [
          { userId: 1, status: 'can', weeksCan: 4, outsideSlotsWeeks: 0 },
          { userId: 2, status: 'cannot', weeksCan: 1, outsideSlotsWeeks: 0 },
          { userId: 3, status: 'unknown', weeksCan: 0, outsideSlotsWeeks: 0 },
        ],
      },
    ],
    oneOff: [
      {
        startsAt: '2030-03-08T17:00:00.000Z',
        endsAt: '2030-03-08T21:00:00.000Z',
        can: 2,
        cannot: 0,
        unknown: 1,
        statuses: [
          { userId: 1, status: 'can' },
          { userId: 2, status: 'can' },
          { userId: 3, status: 'unknown' },
        ],
      },
      {
        startsAt: '2030-03-09T16:00:00.000Z',
        endsAt: '2030-03-09T20:00:00.000Z',
        can: 1,
        cannot: 1,
        unknown: 1,
        statuses: [
          { userId: 1, status: 'can' },
          { userId: 2, status: 'cannot' },
          { userId: 3, status: 'unknown' },
        ],
      },
    ],
    ...patch,
  };
}

export function alternatives(patch: Partial<SessionAlternativesDto> = {}): SessionAlternativesDto {
  const ct = commonTimes();
  return {
    sessionId: 41,
    startsAt: '2030-03-07T17:00:00.000Z',
    timezone: 'Europe/Kyiv',
    durationMinutes: 240,
    from: '2030-03-04T17:00:00.000Z',
    to: '2030-03-10T17:00:00.000Z',
    participants,
    noCalendars: false,
    alternatives: ct.oneOff,
    ...patch,
  };
}

export function session(patch: Partial<SessionDto> = {}): SessionDto {
  return {
    id: 41,
    gameId: 7,
    startsAt: '2030-03-07T17:00:00.000Z',
    durationMinutes: 240,
    startWindowMinutes: null,
    status: 'scheduled',
    origin: 'rule',
    rescheduled: false,
    cancelReason: null,
    summary: null,
    summarySentAt: null,
    doneAt: null,
    myRsvp: null,
    rsvpSummary: null,
    seen: 'seen',
    ...patch,
  };
}

export function poll(patch: Partial<PollDto> = {}): PollDto {
  return {
    id: 5,
    gameId: 7,
    kind: 'regular',
    status: 'open',
    closeReason: null,
    timezone: 'Europe/Kyiv',
    durationMinutes: 240,
    sessionId: null,
    closesAt: '2030-03-03T10:00:00.000Z',
    createdAt: '2030-03-01T10:00:00.000Z',
    closedAt: null,
    options: [
      {
        id: 51,
        position: 1,
        weekday: 4,
        startMin: 1140,
        startsAt: '2030-03-08T17:00:00.000Z',
        yes: 1,
        no: 0,
        maybe: 0,
        votes: [{ userId: 2, value: 'yes' }],
      },
      {
        id: 52,
        position: 2,
        weekday: 5,
        startMin: 1080,
        startsAt: '2030-03-09T16:00:00.000Z',
        yes: 0,
        no: 1,
        maybe: 0,
        votes: [{ userId: 2, value: 'no' }],
      },
    ],
    voters: [
      { userId: 2, nickname: 'Аня', voted: true },
      { userId: 3, nickname: 'Богдан', voted: false },
    ],
    winnerOptionId: 51,
    appliedAt: null,
    appliedOptionId: null,
    appliedSessionId: null,
    isGm: false,
    canVote: true,
    ...patch,
  };
}
