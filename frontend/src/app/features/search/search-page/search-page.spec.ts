import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type {
  AvailabilityDto,
  CatalogDto,
  MeDto,
  SearchFiltersInput,
  SearchGameCardDto,
  SearchResultDto,
} from '@nri/shared';
import { SearchPage } from './search-page';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';

const me = {
  id: 1,
  publicId: 'abcdefghjk',
  nickname: 'Frodo',
  avatarUrl: null,
  birthDate: '1990-01-01',
  role: 'user',
  status: 'active',
  timezone: 'Europe/Kyiv',
  locale: 'uk',
  identities: [],
} satisfies MeDto;

const catalog: CatalogDto = {
  systems: [{ id: 1, slug: 'dnd5e', name: 'D&D 5e', defaultGenreId: 1 }],
  genres: [{ id: 1, slug: 'fantasy' }],
  contentWarnings: [{ id: 3, slug: 'violence' }],
};

const slots: AvailabilityDto = {
  timezone: 'Europe/Kyiv',
  slots: [{ weekday: 1, startMin: 1140, endMin: 1380 }],
  busyDates: [],
};

function card(id: number): SearchGameCardDto {
  return {
    id,
    title: `Гра ${id}`,
    coverUrl: null,
    system: { id: 1, name: 'D&D 5e' },
    systemOther: null,
    genreId: 1,
    gm: { publicId: 'zzzzzzzzzz', nickname: 'Gandalf', avatarUrl: null },
    format: 'online',
    city: null,
    nextSessionAt: '2027-03-02T17:00:00.000Z',
    timezone: 'Europe/Kyiv',
    freeSlots: 3,
    maxPlayers: 5,
    priceUah: null,
    ageRating: 'none',
    kind: 'oneshot',
    language: 'uk',
    status: 'recruiting',
    gmRating: null,
  };
}

describe('SearchPage', () => {
  let harness: RouterTestingHarness;
  let page: SearchPage;
  let http: HttpTestingController;
  let router: Router;

  const settle = async () => {
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
  };
  const el = () => harness.routeNativeElement!;
  const expectSearch = (): TestRequest =>
    http.expectOne((r) => r.method === 'POST' && r.url === '/api/games/search');
  const body = (req: TestRequest) => req.request.body as SearchFiltersInput;
  const flush = async (req: TestRequest, res: SearchResultDto) => {
    req.flush(res);
    await settle();
  };
  const ids = () =>
    Array.from(el().querySelectorAll<HTMLElement>('[data-game-id]')).map((e) =>
      Number(e.dataset['gameId']),
    );
  const loadMore = () => el().querySelector<HTMLButtonElement>('button.load-more');

  async function setup(user: MeDto | null, url = '/', availability?: AvailabilityDto) {
    await TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: '', component: SearchPage }]),
        provideTranslateService(),
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            on: () => new Subject(),
            sessionLost$: new Subject(),
          },
        },
      ],
    });
    TestBed.inject(AuthStore).setMe(user);
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    harness = await RouterTestingHarness.create();
    page = await harness.navigateByUrl(url, SearchPage);
    await settle();
    http.expectOne('/api/catalog').flush(catalog);
    if (availability) {
      http
        .expectOne((r) => r.method === 'GET' && r.url === '/api/me/availability')
        .flush(availability);
    }
    await settle();
  }

  afterEach(() => http.verify());

  it('changing a filter updates the URL and restarts the search without a cursor', async () => {
    await setup(null);
    let req = expectSearch();
    expect(body(req).cursor).toBeUndefined();
    await flush(req, { items: [card(1), card(2)], nextCursor: 'c1' });

    loadMore()!.click();
    await settle();
    req = expectSearch();
    expect(body(req).cursor).toBe('c1');
    await flush(req, { items: [card(3)], nextCursor: 'c2' });
    expect(ids()).toEqual([1, 2, 3]);

    const format = el().querySelector<HTMLSelectElement>('select[name="format"]')!;
    format.value = 'online';
    format.dispatchEvent(new Event('change'));
    await settle();

    expect(router.url).toContain('format=online');
    req = expectSearch();
    expect(body(req).cursor).toBeUndefined();
    expect(body(req).format).toBe('online');
    await flush(req, { items: [card(9)], nextCursor: null });
    expect(ids()).toEqual([9]);
  });

  it('reads filters from the URL', async () => {
    await setup(null, '/?format=offline&city=Київ&systems=1&sort=newest&free=1');
    const b = body(expectSearch());
    expect(b).toMatchObject({
      format: 'offline',
      city: 'Київ',
      systemIds: [1],
      sort: 'newest',
      hasFreeSlots: true,
    });
  });

  it('sort by GM rating is offered and sent as sort=gm_rating', async () => {
    await setup(null, '/?sort=gm_rating');
    expect(body(expectSearch()).sort).toBe('gm_rating');
    const option = el().querySelector<HTMLOptionElement>(
      'select[name="sort"] option[value="gm_rating"]',
    )!;
    expect(option.textContent).toContain('search.sort.gm_rating');
    expect(option.selected).toBe(true);
  });

  it('load more appends items without duplicates', async () => {
    await setup(null);
    await flush(expectSearch(), { items: [card(1), card(2)], nextCursor: 'c1' });
    loadMore()!.click();
    await settle();
    await flush(expectSearch(), { items: [card(2), card(3)], nextCursor: null });
    expect(ids()).toEqual([1, 2, 3]);
    expect(loadMore()).toBeNull();
  });

  it('guest: calendar is off and the saved calendar is not requested', async () => {
    await setup(null);
    http.expectNone('/api/me/availability');
    expect(body(expectSearch()).calendar).toEqual({ mode: 'off', includePartial: false });
  });

  it('user with saved slots: calendar defaults to "mine"', async () => {
    await setup(me, '/', slots);
    expect(body(expectSearch()).calendar).toEqual({ mode: 'mine', includePartial: false });
  });

  it('user without slots: calendar defaults to "off"', async () => {
    await setup(me, '/', { ...slots, slots: [] });
    expect(body(expectSearch()).calendar?.mode).toBe('off');
  });

  it('cal=off in the URL overrides the default', async () => {
    await setup(me, '/?cal=off', slots);
    expect(body(expectSearch()).calendar?.mode).toBe('off');
  });

  it('the "partially fitting" toggle is sent with the calendar', async () => {
    await setup(me, '/?partial=1', slots);
    expect(body(expectSearch()).calendar).toEqual({ mode: 'mine', includePartial: true });
  });

  it('a custom calendar is sent with the search and never saved', async () => {
    await setup(me, '/', slots);
    await flush(expectSearch(), { items: [card(1)], nextCursor: null });
    const custom: AvailabilityDto = {
      timezone: 'Europe/Kyiv',
      slots: [{ weekday: 5, startMin: 600, endMin: 1200 }],
      busyDates: [],
    };
    page.useCustomCalendar(custom);
    await settle();
    const req = expectSearch();
    expect(body(req).calendar).toEqual({
      mode: 'custom',
      availability: custom,
      includePartial: false,
    });
    expect(body(req).cursor).toBeUndefined();
    await flush(req, { items: [], nextCursor: null });
    http.expectNone((r) => r.method === 'PUT' && r.url === '/api/me/availability');
    expect(router.url).toBe('/');
  });

  it('"change for this search" opens the editor, applies without saving, reset returns to mine', async () => {
    await setup(me, '/?cal=off', slots);
    await flush(expectSearch(), { items: [card(1)], nextCursor: null });

    const select = el().querySelector<HTMLSelectElement>('select[name=calendar]')!;
    select.value = 'custom';
    select.dispatchEvent(new Event('change'));
    await settle();
    // Редактор стартує з копії збереженого календаря — без нового GET.
    const editor = el().querySelector('nri-availability-editor')!;
    expect(editor).not.toBeNull();
    expect(
      editor.querySelector('[data-day="1"][data-cell="38"]')!.getAttribute('aria-selected'),
    ).toBe('true');
    let req = expectSearch();
    expect(body(req).calendar).toEqual({
      mode: 'custom',
      availability: slots,
      includePartial: false,
    });
    await flush(req, { items: [], nextCursor: null });

    // Додаємо суботу 10:00–10:30 і застосовуємо.
    const sat = editor.querySelector<HTMLElement>('[data-day="5"][data-cell="20"]')!;
    sat.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    await settle();
    editor.querySelector<HTMLButtonElement>('button.apply')!.click();
    await settle();
    req = expectSearch();
    expect(body(req).calendar).toMatchObject({
      mode: 'custom',
      availability: {
        slots: [
          { weekday: 1, startMin: 1140, endMin: 1380 },
          { weekday: 5, startMin: 600, endMin: 630 },
        ],
      },
    });
    await flush(req, { items: [], nextCursor: null });
    expect(router.url).toBe('/?cal=off');

    el().querySelector<HTMLButtonElement>('button.custom-reset')!.click();
    await settle();
    expect(el().querySelector('nri-availability-editor')).toBeNull();
    expect(router.url).toBe('/');
    expect(body(expectSearch()).calendar?.mode).toBe('mine');
    http.expectNone((r) => r.method === 'PUT');
  });

  it('refetches the saved calendar only when the user id changes', async () => {
    await setup(me, '/', slots);
    await flush(expectSearch(), { items: [card(1)], nextCursor: null });
    const auth = TestBed.inject(AuthStore);

    // Той самий користувач (оновлений профіль) — без нового GET.
    auth.setMe({ ...me, nickname: 'Frodo2' });
    await settle();
    http.expectNone('/api/me/availability');

    // Інший користувач — hasSlots скидається, календар запитується знову.
    auth.setMe({ ...me, id: 2, publicId: 'qqqqqqqqqq' });
    await settle();
    http.expectNone((r) => r.url === '/api/games/search');
    http.expectOne('/api/me/availability').flush({ ...slots, slots: [] });
    await settle();
    expect(body(expectSearch()).calendar?.mode).toBe('off');
  });

  it('an invalid cursor silently restarts from page 1', async () => {
    await setup(null);
    await flush(expectSearch(), { items: [card(1)], nextCursor: 'stale' });
    loadMore()!.click();
    await settle();
    expectSearch().flush(
      { error: { code: 'VALIDATION', details: { reason: 'INVALID_CURSOR' } } },
      { status: 400, statusText: 'Bad Request' },
    );
    await settle();
    const req = expectSearch();
    expect(body(req).cursor).toBeUndefined();
    await flush(req, { items: [card(1), card(2)], nextCursor: null });
    expect(ids()).toEqual([1, 2]);
    expect(el().querySelector('[role="alert"]')).toBeNull();
  });

  it('empty pages with a cursor keep fetching, then offer "load more"', async () => {
    await setup(null);
    await flush(expectSearch(), { items: [], nextCursor: 'c1' });
    let req = expectSearch();
    expect(body(req).cursor).toBe('c1');
    await flush(req, { items: [], nextCursor: 'c2' });
    req = expectSearch();
    expect(body(req).cursor).toBe('c2');
    await flush(req, { items: [], nextCursor: 'c3' });
    http.expectNone('/api/games/search');
    expect(loadMore()).not.toBeNull();
    expect(el().textContent).not.toContain('search.empty.title');
  });

  it('shows the empty state when nothing is found', async () => {
    await setup(null);
    await flush(expectSearch(), { items: [], nextCursor: null });
    expect(el().textContent).toContain('search.empty.title');
  });

  it('a network error shows a retry button that repeats the search', async () => {
    await setup(null);
    expectSearch().flush(null, { status: 0, statusText: 'Network error' });
    await settle();
    const retry = el().querySelector<HTMLButtonElement>('.search-error button')!;
    expect(retry).not.toBeNull();
    retry.click();
    await settle();
    await flush(expectSearch(), { items: [card(1)], nextCursor: null });
    expect(ids()).toEqual([1]);
  });
});
