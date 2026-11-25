import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { AvailabilityDto, GameBusyDto, MeDto } from '@nri/shared';
import { AvailabilityEditor } from './availability-editor';
import { cellsToSlots, gameBusyCells, slotsToCells } from './availability-grid';
import { AuthStore } from '../../../core/auth/auth.store';
import { browserZone } from '../../../core/i18n/dates';
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
  uiTheme: 'quest-board',
  availableThemes: ['quest-board'],
  uiPrefs: { tearAnimation: true },
  identities: [],
} satisfies MeDto;

const empty: AvailabilityDto = { timezone: 'Europe/Kyiv', slots: [], busyDates: [] };

describe('availability-grid', () => {
  it('converts slots to cells and back, merging adjacent cells', () => {
    const slots = [
      { weekday: 1 as const, startMin: 1140, endMin: 1380 },
      { weekday: 6 as const, startMin: 0, endMin: 1440 },
    ];
    const cells = slotsToCells(slots);
    expect(cells.filter(Boolean)).toHaveLength(8 + 48);
    expect(cellsToSlots(cells)).toEqual(slots);
  });
});

describe('gameBusyCells', () => {
  const busy = (start: string, end: string) => ({
    gameId: 1,
    gameTitle: 'Гра',
    sessionId: 1,
    start,
    end,
  });
  const busyIndexes = (cells: unknown[][]) => cells.flatMap((c, i) => (c.length ? [i] : []));

  it('uses the zoned minute of day (Asia/Kathmandu, UTC+5:45)', () => {
    // Пт 27.11 19:00–20:00 за Катманду = 13:15–14:15 UTC.
    const cells = gameBusyCells(
      [busy('2026-11-27T13:15:00.000Z', '2026-11-27T14:15:00.000Z')],
      'Asia/Kathmandu',
    );
    expect(busyIndexes(cells)).toEqual([4 * 48 + 38, 4 * 48 + 39]);
  });

  it('marks a partially covered cell and stops at the end', () => {
    // 19:10–19:40 за Києвом → клітинки 19:00 і 19:30.
    const cells = gameBusyCells(
      [busy('2026-11-27T17:10:00.000Z', '2026-11-27T17:40:00.000Z')],
      'Europe/Kyiv',
    );
    expect(busyIndexes(cells)).toEqual([4 * 48 + 38, 4 * 48 + 39]);
  });
});

describe('AvailabilityEditor', () => {
  let fixture: ComponentFixture<AvailabilityEditor>;
  let http: HttpTestingController;
  let emitted: AvailabilityDto[];

  const el = () => fixture.nativeElement as HTMLElement;
  const cell = (day: number, index: number) =>
    el().querySelector<HTMLElement>(`[role=gridcell][data-day="${day}"][data-cell="${index}"]`)!;
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const pointer = (type: string, target: EventTarget) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));
  const key = (target: HTMLElement, k: string, shiftKey = false) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, shiftKey }));
  const button = (cls: string) => el().querySelector<HTMLButtonElement>(`button.${cls}`)!;

  const gameBusyUrl = '/api/me/calendar/game-busy';
  /** Зайнятість від ігор запитується лише в режимі `save`, після завантаження календаря. */
  let busyParams: { from: string | null; to: string | null } | null = null;
  const flushGameBusy = (busy: GameBusyDto[] = []) => {
    const req = http.expectOne((r) => r.method === 'GET' && r.url === gameBusyUrl);
    busyParams = { from: req.request.params.get('from'), to: req.request.params.get('to') };
    req.flush(busy);
  };

  async function setup(
    mode: 'save' | 'custom',
    initial: AvailabilityDto | null = null,
    busy: GameBusyDto[] = [],
  ) {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
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
    TestBed.inject(AuthStore).setMe(me);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AvailabilityEditor);
    fixture.componentRef.setInput('mode', mode);
    fixture.componentRef.setInput('initial', initial);
    emitted = [];
    fixture.componentInstance.changed.subscribe((a) => emitted.push(a));
    await settle();
    if (!initial) {
      http.expectOne((r) => r.method === 'GET' && r.url === '/api/me/availability').flush(empty);
      await settle();
    }
    if (mode === 'save') {
      flushGameBusy(busy);
      await settle();
    } else {
      http.expectNone(gameBusyUrl);
    }
  }

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  it('renders an accessible 7 x 48 grid with labelled cells', async () => {
    await setup('save');
    const grid = el().querySelector('[role=grid]')!;
    expect(grid.getAttribute('aria-multiselectable')).toBe('true');
    expect(el().querySelectorAll('[role=gridcell]')).toHaveLength(7 * 48);
    expect(cell(1, 38).getAttribute('aria-label')).toContain('19:00');
    expect(cell(1, 38).getAttribute('aria-selected')).toBe('false');
    // Рівно одна клітинка в порядку табуляції (roving tabindex).
    expect(el().querySelectorAll('[role=gridcell][tabindex="0"]')).toHaveLength(1);
  });

  it('dragging from Tue 19:00 to Tue 23:00 saves the slot {1, 1140, 1380}', async () => {
    await setup('save');
    pointer('pointerdown', cell(1, 38));
    pointer('pointerenter', cell(1, 42));
    pointer('pointerenter', cell(1, 45)); // 22:30–23:00
    pointer('pointerup', document);
    await settle();
    expect(cell(1, 45).getAttribute('aria-selected')).toBe('true');
    expect(cell(1, 46).getAttribute('aria-selected')).toBe('false');

    button('save').click();
    await settle();
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === '/api/me/availability');
    // Пояс — лише для читання (R5): PUT його не надсилає й пояс акаунта не змінює.
    expect(put.request.body).toEqual({
      slots: [{ weekday: 1, startMin: 1140, endMin: 1380 }],
      busyDates: [],
    });
    const saved = { ...empty, slots: [{ weekday: 1 as const, startMin: 1140, endMin: 1380 }] };
    put.flush(saved);
    await settle();
    http.expectNone('/api/me');
    expect(emitted).toEqual([saved]);
  });

  it('dragging over selected cells clears them', async () => {
    await setup('save', {
      ...empty,
      slots: [{ weekday: 2, startMin: 600, endMin: 720 }],
    });
    pointer('pointerdown', cell(2, 20));
    pointer('pointerenter', cell(2, 21));
    pointer('pointerup', document);
    await settle();
    expect(cell(2, 20).getAttribute('aria-selected')).toBe('false');
    expect(cell(2, 22).getAttribute('aria-selected')).toBe('true');
  });

  it('keyboard: arrows move focus, space toggles, shift+arrow extends', async () => {
    await setup('custom', empty);
    const start = cell(1, 38);
    start.focus();
    key(start, ' ');
    await settle();
    expect(cell(1, 38).getAttribute('aria-selected')).toBe('true');

    key(cell(1, 38), 'ArrowDown');
    await settle();
    expect(document.activeElement).toBe(cell(1, 39));
    expect(cell(1, 39).getAttribute('tabindex')).toBe('0');
    key(cell(1, 39), ' ');
    await settle();

    key(cell(1, 39), 'ArrowDown', true);
    await settle();
    expect(document.activeElement).toBe(cell(1, 40));

    key(cell(1, 40), 'ArrowRight');
    await settle();
    expect(document.activeElement).toBe(cell(2, 40));
    expect(cell(2, 40).getAttribute('aria-selected')).toBe('false');

    button('apply').click();
    await settle();
    expect(emitted).toEqual([
      {
        timezone: 'Europe/Kyiv',
        slots: [{ weekday: 1, startMin: 1140, endMin: 1230 }],
        busyDates: [],
      },
    ]);
    http.expectNone((r) => r.method === 'PUT');
  });

  it('custom mode never saves and shows no save button', async () => {
    await setup('custom', empty);
    expect(el().querySelector('button.save')).toBeNull();
    expect(button('apply')).toBeTruthy();
  });

  it('save mode shows the account time zone with a link to account settings, no device-zone switch', async () => {
    vi.spyOn(browserZone, 'get').mockReturnValue('Asia/Tokyo');
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
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
    TestBed.inject(AuthStore).setMe({ ...me, timezone: 'America/New_York' });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AvailabilityEditor);
    fixture.componentRef.setInput('mode', 'save');
    await settle();
    http
      .expectOne((r) => r.method === 'GET' && r.url === '/api/me/availability')
      .flush({ ...empty, timezone: 'America/New_York' });
    await settle();
    flushGameBusy();
    await settle();
    const tz = el().querySelector<HTMLElement>('.tz')!;
    expect(tz.textContent).toContain('calendar.accountTimezone');
    expect(tz.querySelector('a[href="/account"]')).not.toBeNull();
    expect(el().querySelector('.use-browser-tz')).toBeNull();
    expect(el().textContent).not.toContain('calendar.useBrowserTz');
    expect(el().textContent).not.toContain('calendar.timezoneHint');
  });

  describe('game sessions', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      // Середа, 12:00 за Києвом (UTC+2).
      vi.setSystemTime(new Date('2026-11-25T10:00:00.000Z'));
    });
    afterEach(() => vi.useRealTimers());

    const session: GameBusyDto = {
      gameId: 3,
      gameTitle: 'Туман над Дніпром',
      sessionId: 12,
      // Чт 26.11, 19:00–22:00 за Києвом.
      start: '2026-11-26T17:00:00.000Z',
      end: '2026-11-26T20:00:00.000Z',
    };

    it('requests the next 7 days from the start of today in the account zone', async () => {
      await setup('save');
      expect(busyParams).toEqual({
        from: '2026-11-24T22:00:00.000Z',
        to: '2026-12-01T22:00:00.000Z',
      });
      expect(el().querySelector('.legend')!.textContent).toContain('calendar.gameBusy.legend');
    });

    it('busy cells are hatched, labelled with the game title and keep free time editable', async () => {
      await setup('save', null, [session]);
      const busy = cell(3, 38);
      expect(busy.classList).toContain('game-busy');
      expect(busy.getAttribute('aria-label')).toContain('Туман над Дніпром');
      expect(busy.getAttribute('title')).toBe('Туман над Дніпром, 26.11, 19:00–22:00');
      expect(busy.getAttribute('aria-label')).toContain('26.11, 19:00–22:00');
      expect(cell(3, 43).classList).toContain('game-busy');
      expect(cell(3, 44).classList).not.toContain('game-busy');
      expect(cell(3, 37).classList).not.toContain('game-busy');
      expect(cell(3, 44).getAttribute('aria-label')).not.toContain('Туман');
      // Сесія — не вільний час: позначка не змінює слотів.
      expect(busy.getAttribute('aria-selected')).toBe('false');
      expect(el().querySelector('.legend .swatch.game-busy')).not.toBeNull();
      expect(el().querySelector('.busy-note')!.textContent).toContain('calendar.gameBusy.note');
    });

    it('skips ended sessions and refreshes every 5 minutes with a moving window', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      vi.setSystemTime(new Date('2026-11-25T21:58:00.000Z')); // 23:58 за Києвом
      const ended = {
        ...session,
        start: '2026-11-25T18:00:00.000Z',
        end: '2026-11-25T21:00:00.000Z',
      };
      await setup('save', null, [ended, session]);
      expect(cell(2, 40).classList).not.toContain('game-busy'); // ср 20:00 — уже минула
      expect(cell(3, 38).classList).toContain('game-busy');

      vi.advanceTimersByTime(5 * 60_000); // 00:03 четверга — нова доба
      await settle();
      flushGameBusy([]);
      await settle();
      expect(busyParams!.from).toBe('2026-11-25T22:00:00.000Z');
      expect(busyParams!.to).toBe('2026-12-02T22:00:00.000Z');
      expect(cell(3, 38).classList).not.toContain('game-busy');
    });
  });
});
