import type { RestrictedGameDto, SearchGameCardDto } from '@nri/shared';
import { browserZone } from '../i18n/dates';
import {
  toGameCardVm,
  type FullGameCardVm,
  type GameCardVmOptions,
  type RestrictedGameCardVm,
} from './game-card.vm';

const game: SearchGameCardDto = {
  id: 5,
  title: 'Туман над Дніпром',
  summary: 'Готичний жах у тумані.',
  coverUrl: 'https://example.com/cover.png',
  system: { id: 1, name: 'D&D 5e' },
  systemOther: null,
  genreId: 1,
  gm: { publicId: 'zzzzzzzzzz', nickname: 'Gandalf', avatarUrl: null },
  format: 'offline',
  city: 'Київ',
  nextSessionAt: '2027-03-02T17:00:00.000Z',
  timezone: 'Europe/Kyiv',
  freeSlots: 2,
  maxPlayers: 5,
  priceUah: 150,
  ageRating: '18+',
  kind: 'campaign',
  language: 'uk',
  status: 'recruiting',
  gmRating: null,
  fit: 'partial',
};

const restricted: RestrictedGameDto = {
  id: 6,
  title: 'Темна вежа',
  gm: { publicId: 'zzzzzzzzzz', nickname: 'Gandalf', avatarUrl: null },
  ageRating: '21+',
  restricted: true,
};

const opts = { guest: false, genreKey: (id: number) => `genres.g${id}` };
const full = (g: object, o: GameCardVmOptions = opts) =>
  toGameCardVm(g as SearchGameCardDto, null, o) as FullGameCardVm;

describe('toGameCardVm', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps the card fields and translation keys', () => {
    const vm = full(game);
    expect(vm).toMatchObject({
      restricted: false,
      id: 5,
      title: 'Туман над Дніпром',
      systemName: 'D&D 5e',
      genreKey: 'genres.g1',
      formatKey: 'games.format.offline',
      city: 'Київ',
      kindKey: 'games.kind.campaign',
      languageKey: 'games.language.uk',
      priceUah: 150,
      gm: { nickname: 'Gandalf', blocked: false, rating: null, showRating: true },
    });
    expect(full({ ...game, system: null, systemOther: 'Своя' }).systemName).toBe('Своя');
  });

  it('short description: from the card, blank → null, never on a restricted card', () => {
    expect(full(game).summary).toBe('Готичний жах у тумані.');
    expect(full({ ...game, summary: '   ' }).summary).toBeNull();
    expect(full({ ...game, summary: null }).summary).toBeNull();
    // Старий бекенд без поля — теж без опису.
    const legacy: Partial<SearchGameCardDto> = { ...game };
    delete legacy.summary;
    expect(full(legacy).summary).toBeNull();
    const vm = toGameCardVm({ ...restricted, summary: 'SECRET' } as never, null, opts);
    expect(JSON.stringify(vm)).not.toContain('SECRET');
  });

  it('one-line summaries: system · kind · genre and format · city · language', () => {
    const vm = full(game);
    expect(vm.systemLine).toEqual([
      { text: 'D&D 5e' },
      { key: 'games.kind.campaign' },
      { key: 'genres.g1' },
    ]);
    expect(vm.whereLine).toEqual([
      { key: 'games.format.offline' },
      { text: 'Київ' },
      { key: 'games.language.uk' },
    ]);
    expect(full({ ...game, city: null }).whereLine).toHaveLength(2);
  });

  it('badges: fit, age (not «none»), status (not while recruiting)', () => {
    expect(full(game).badges.map((b) => [b.kind, b.value, b.labelKey, b.icon])).toEqual([
      ['fit', 'partial', 'search.fit.partial', 'event_note'],
      ['age', '18+', 'games.ageRating.18+', null],
    ]);
    expect(full({ ...game, fit: 'full' }).badges[0]!.icon).toBe('event_available');
    expect(full({ ...game, fit: undefined, ageRating: 'none' }).badges).toEqual([]);
    expect(
      full({ ...game, fit: undefined, ageRating: 'none', status: 'cancelled' }).badges,
    ).toEqual([
      { kind: 'status', value: 'cancelled', labelKey: 'games.status.cancelled', icon: null },
    ]);
  });

  it('next session and free seats only for recruiting/started games', () => {
    expect(full(game).showSchedule).toBe(true);
    expect(full({ ...game, status: 'started' }).showSchedule).toBe(true);
    expect(full({ ...game, status: 'finished' }).showSchedule).toBe(false);
    expect(full({ ...game, status: 'cancelled' }).showSchedule).toBe(false);
    expect(full({ ...game, nextSessionAt: null }).nextSession).toBeNull();
  });

  it('next session in the viewer zone, never with a zone label', () => {
    vi.spyOn(browserZone, 'get').mockReturnValue('Europe/Warsaw');
    expect(full(game).nextSession).toContain('18:00');
    expect(full(game).nextSession).not.toMatch(/GMT|EET|CET/);
    vi.spyOn(browserZone, 'get').mockReturnValue('Europe/Kyiv');
    expect(full(game).nextSession).toContain('19:00');
    expect(full(game).nextSession).not.toMatch(/GMT|EET/);
  });

  it('seats: players see taken of capacity, GMs — free; fill follows the shown count', () => {
    expect(full(game).seats).toEqual({
      mode: 'taken',
      count: 3,
      max: 5,
      fill: 0.6,
      textKey: 'search.card.seatsTaken',
    });
    expect(full(game, { ...opts, viewMode: 'player' }).seats.count).toBe(3);
    expect(full(game, { ...opts, viewMode: 'gm' }).seats).toEqual({
      mode: 'free',
      count: 2,
      max: 5,
      fill: 0.4,
      textKey: 'search.card.seatsFree',
    });
    // Ніхто не записався — порожньо гравцю, повно майстру; усі місця зайняті — навпаки.
    expect(full({ ...game, freeSlots: 5 }).seats).toMatchObject({ count: 0, fill: 0 });
    expect(full({ ...game, freeSlots: 0 }).seats).toMatchObject({ count: 5, fill: 1 });
    expect(full({ ...game, freeSlots: 0 }, { ...opts, viewMode: 'gm' }).seats.fill).toBe(0);
    // Розсинхрон даних не дає від'ємних чи більших за місткість чисел.
    expect(full({ ...game, freeSlots: 9 }).seats).toMatchObject({ count: 0, fill: 0 });
    expect(full({ ...game, freeSlots: -1 }).seats).toMatchObject({ count: 5, fill: 1 });
  });

  it('a blocked GM is flagged', () => {
    expect(full({ ...game, gm: { ...game.gm, blocked: true } }).gm.blocked).toBe(true);
  });

  it('restricted card keeps only the allowed fields, even if details leak', () => {
    const vm = toGameCardVm(
      {
        ...restricted,
        description: 'SECRET',
        coverUrl: 'https://example.com/secret.png',
        city: 'Секретне місто',
        gmRating: 4.8,
      } as RestrictedGameDto,
      null,
      opts,
    ) as RestrictedGameCardVm;
    expect(vm.restricted).toBe(true);
    expect(vm.restrictedKey).toBe('games.restricted.21+');
    expect(vm.badges.map((b) => b.labelKey)).toEqual(['games.ageRating.21+']);
    expect(vm.gm).toMatchObject({ rating: null, showRating: false });
    expect(JSON.stringify(vm)).not.toMatch(/SECRET|secret\.png|Секретне/);
    expect(vm.loginReturnTo).toBeNull();
  });

  it('restricted card invites a guest to log in with a return to the game', () => {
    const vm = toGameCardVm(restricted, null, { ...opts, guest: true }) as RestrictedGameCardVm;
    expect(vm.loginReturnTo).toBe('/games/6');
  });
});
