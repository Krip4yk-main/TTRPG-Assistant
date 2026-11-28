import type { MyGameCardDto } from '@nri/shared';
import { deadFlags, toMyGameItemVm } from './my-game-item.vm';

function card(id: number, status: MyGameCardDto['status']): MyGameCardDto {
  return {
    id,
    title: `Гра ${id}`,
    summary: null,
    coverUrl: null,
    system: { id: 1, name: 'D&D 5e' },
    systemOther: null,
    genreId: 1,
    gm: { publicId: 'abcdefghjk', nickname: 'Gandalf', avatarUrl: null },
    format: 'online',
    city: null,
    nextSessionAt: '2027-03-02T17:00:00.000Z',
    nextSessionWindowMinutes: null,
    startsAt: '2027-03-02T17:00:00.000Z',
    timezone: 'Europe/Kyiv',
    freeSlots: 4,
    maxPlayers: 5,
    priceUah: null,
    ageRating: 'none',
    kind: 'oneshot',
    language: 'uk',
    status,
    gmRating: null,
    minPlayers: 2,
    memberCount: 1,
    pendingApplications: 0,
    seen: 'seen',
    staleness: 'ok',
    suspicious: false,
  };
}

const vm = (g: MyGameCardDto, seen: 'new' | 'updated' | null = null) =>
  toMyGameItemVm(g, { me: null, seen });
const actions = (g: MyGameCardDto) => vm(g).actions.map((a) => a.id);

describe('toMyGameItemVm', () => {
  it('status-specific actions; editing is a link', () => {
    expect(actions(card(1, 'draft'))).toEqual(['edit', 'publish', 'cancel']);
    expect(actions(card(2, 'recruiting'))).toEqual(['edit', 'start', 'cancel']);
    expect(actions(card(3, 'started'))).toEqual(['edit', 'finish', 'cancel']);
    expect(actions(card(4, 'finished'))).toEqual([]);
    expect(actions(card(5, 'cancelled'))).toEqual([]);
    const edit = vm(card(2, 'recruiting')).actions[0]!;
    expect(edit).toMatchObject({ link: ['/games', 2, 'edit'], emphasis: 'stroked' });
    const cancel = vm(card(2, 'recruiting')).actions.find((a) => a.id === 'cancel')!;
    expect(cancel).toMatchObject({ danger: true, link: null, labelKey: 'games.actions.cancel' });
  });

  it('campaign pause: «pause» for running campaigns; «resume» / «recruit» on paused, plus edit', () => {
    const campaign = (id: number, status: MyGameCardDto['status']): MyGameCardDto => ({
      ...card(id, status),
      kind: 'campaign',
    });
    expect(actions(campaign(1, 'recruiting'))).toEqual(['edit', 'start', 'pause', 'cancel']);
    expect(actions(campaign(2, 'started'))).toEqual(['edit', 'finish', 'pause', 'cancel']);
    expect(actions(campaign(3, 'draft'))).toEqual(['edit', 'publish', 'cancel']);
    // Ваншот на паузу не ставиться.
    expect(actions(card(4, 'started'))).not.toContain('pause');
    const paused = vm(campaign(5, 'paused'));
    expect(paused.actions.map((a) => a.id)).toEqual([
      'edit',
      'resume',
      'recruit',
      'finish',
      'cancel',
    ]);
    expect(paused.statusKey).toBe('games.status.paused');
    expect(paused.actions[0]).toMatchObject({ link: ['/games', 5, 'edit'] });
    expect(paused.actions[1]).toMatchObject({
      labelKey: 'games.actions.resume',
      emphasis: 'stroked',
      link: null,
    });
    expect(paused.actions[2]).toMatchObject({ labelKey: 'games.actions.recruit', link: null });
    expect(paused.applications).toEqual({ link: ['/games', 5, 'applications'], pending: 0 });
  });

  it('cover: passed through (null — none)', () => {
    expect(vm(card(1, 'recruiting')).coverUrl).toBeNull();
    const url = 'https://example.com/c.png';
    expect(vm({ ...card(1, 'recruiting'), coverUrl: url }).coverUrl).toBe(url);
  });

  it('«all ok» and «close» come first, for stale and dead games only', () => {
    expect(actions({ ...card(6, 'recruiting'), staleness: 'stale' })).toEqual([
      'still-alive',
      'close-dead',
      'edit',
      'start',
      'cancel',
    ]);
    expect(actions({ ...card(7, 'started'), staleness: 'dead', suspicious: true })).toEqual([
      'still-alive',
      'close-dead',
      'edit',
      'finish',
      'cancel',
    ]);
    expect(actions({ ...card(8, 'started'), suspicious: true })).toEqual([
      'edit',
      'finish',
      'cancel',
    ]);
  });

  it('flags in order of importance with badge and explanation keys', () => {
    expect(deadFlags(card(2, 'recruiting'))).toEqual([]);
    expect(deadFlags({ staleness: 'dead', suspicious: true })).toEqual(['dead', 'suspicious']);
    expect(vm({ ...card(8, 'started'), suspicious: true }).flags).toEqual([
      {
        flag: 'suspicious',
        badgeKey: 'games.dead.badge.suspicious',
        explainKey: 'games.dead.explain.suspicious',
      },
    ]);
  });

  it('applications link except for drafts, with the pending count', () => {
    expect(vm(card(1, 'draft')).applications).toBeNull();
    expect(vm({ ...card(2, 'recruiting'), pendingApplications: 3 }).applications).toEqual({
      link: ['/games', 2, 'applications'],
      pending: 3,
    });
  });

  it('status, seen badge, meta and next session', () => {
    const v = vm(card(3, 'started'), 'updated');
    expect(v).toMatchObject({
      status: 'started',
      statusKey: 'games.status.started',
      seen: 'updated',
      systemName: 'D&D 5e',
      formatKey: 'games.format.online',
      kindKey: 'games.kind.oneshot',
      freeSlots: 4,
      maxPlayers: 5,
    });
    expect(v.nextSession).toBeTruthy();
    expect(vm({ ...card(3, 'started'), nextSessionAt: null }).nextSession).toBeNull();
  });

  it('an approximate next session: range and the «TBD» flag', () => {
    const v = vm({ ...card(3, 'started'), nextSessionWindowMinutes: 90 });
    expect(v.nextSession).toContain('–');
    expect(v.nextSessionApprox).toBe(true);
    expect(vm(card(3, 'started')).nextSessionApprox).toBe(false);
  });

  it('a draft without a start date reads «date not set yet» instead of «no next session»', () => {
    expect(vm(card(3, 'started')).noNextKey).toBe('games.my.noNextSession');
    const draft = { ...card(4, 'draft'), startsAt: null, nextSessionAt: null };
    expect(vm(draft)).toMatchObject({ nextSession: null, noNextKey: 'games.noStartDate' });
  });

  it('seats follow the view: taken for players (default), free for GMs', () => {
    const g = card(3, 'started');
    expect(toMyGameItemVm(g, { me: null, seen: null }).seats).toEqual({
      mode: 'taken',
      count: 1,
      max: 5,
      fill: 0.2,
      textKey: 'search.card.seatsTaken',
    });
    expect(toMyGameItemVm(g, { me: null, seen: null, viewMode: 'gm' }).seats).toEqual({
      mode: 'free',
      count: 4,
      max: 5,
      fill: 0.8,
      textKey: 'search.card.seatsFree',
    });
  });
});
