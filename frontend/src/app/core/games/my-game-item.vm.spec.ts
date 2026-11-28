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
  it('status-specific actions ordered primary → secondary → danger; editing is a link', () => {
    expect(actions(card(1, 'draft'))).toEqual(['publish', 'edit', 'cancel']);
    expect(actions(card(2, 'recruiting'))).toEqual(['start', 'edit', 'cancel']);
    // Без переходу вперед головна — редагування; «завершити» — небезпечна (незворотна).
    expect(actions(card(3, 'started'))).toEqual(['edit', 'finish', 'cancel']);
    expect(actions(card(4, 'finished'))).toEqual([]);
    expect(actions(card(5, 'cancelled'))).toEqual([]);
    const ranks = (g: MyGameCardDto) => vm(g).actions.map((a) => a.rank);
    expect(ranks(card(2, 'recruiting'))).toEqual(['primary', 'secondary', 'danger']);
    expect(ranks(card(3, 'started'))).toEqual(['primary', 'danger', 'danger']);
    const edit = vm(card(2, 'recruiting')).actions.find((a) => a.id === 'edit')!;
    expect(edit).toMatchObject({ link: ['/games', 2, 'edit'], rank: 'secondary' });
    const cancel = vm(card(2, 'recruiting')).actions.find((a) => a.id === 'cancel')!;
    expect(cancel).toMatchObject({ rank: 'danger', link: null, labelKey: 'games.actions.cancel' });
  });

  it('campaign pause: «pause» for running campaigns; «resume» / «recruit» on paused, plus edit', () => {
    const campaign = (id: number, status: MyGameCardDto['status']): MyGameCardDto => ({
      ...card(id, status),
      kind: 'campaign',
    });
    expect(actions(campaign(1, 'recruiting'))).toEqual(['start', 'edit', 'pause', 'cancel']);
    expect(actions(campaign(2, 'started'))).toEqual(['edit', 'pause', 'finish', 'cancel']);
    expect(actions(campaign(3, 'draft'))).toEqual(['publish', 'edit', 'cancel']);
    // Ваншот на паузу не ставиться.
    expect(actions(card(4, 'started'))).not.toContain('pause');
    const paused = vm(campaign(5, 'paused'));
    // Як на панелі паузи сторінки гри: «Відновити» — головна, «Донабір» — другорядна,
    // «Завершити» / «Скасувати» — небезпечні.
    expect(paused.actions.map((a) => [a.id, a.rank])).toEqual([
      ['resume', 'primary'],
      ['edit', 'secondary'],
      ['recruit', 'secondary'],
      ['finish', 'danger'],
      ['cancel', 'danger'],
    ]);
    expect(paused.statusKey).toBe('games.status.paused');
    expect(paused.actions[0]).toMatchObject({ labelKey: 'games.actions.resume', link: null });
    expect(paused.actions[1]).toMatchObject({ link: ['/games', 5, 'edit'] });
    expect(paused.actions[2]).toMatchObject({ labelKey: 'games.actions.recruit', link: null });
    expect(paused.applications).toEqual({ link: ['/games', 5, 'applications'], pending: 0 });
  });

  it('cover: passed through (null — none)', () => {
    expect(vm(card(1, 'recruiting')).coverUrl).toBeNull();
    const url = 'https://example.com/c.png';
    expect(vm({ ...card(1, 'recruiting'), coverUrl: url }).coverUrl).toBe(url);
  });

  it('«all ok» is the primary action and «close» a danger one, for stale and dead games only', () => {
    expect(actions({ ...card(6, 'recruiting'), staleness: 'stale' })).toEqual([
      'still-alive',
      'edit',
      'start',
      'close-dead',
      'cancel',
    ]);
    expect(vm({ ...card(6, 'recruiting'), staleness: 'stale' }).actions.map((a) => a.rank)).toEqual(
      ['primary', 'secondary', 'secondary', 'danger', 'danger'],
    );
    expect(actions({ ...card(7, 'started'), staleness: 'dead', suspicious: true })).toEqual([
      'still-alive',
      'edit',
      'close-dead',
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
