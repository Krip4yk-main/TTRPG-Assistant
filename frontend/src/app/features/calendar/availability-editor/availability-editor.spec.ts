import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { AvailabilityDto, MeDto } from '@nri/shared';
import { AvailabilityEditor } from './availability-editor';
import { cellsToSlots, slotsToCells } from './availability-grid';
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

  async function setup(mode: 'save' | 'custom', initial: AvailabilityDto | null = null) {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
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
  }

  afterEach(() => http.verify());

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
    expect(put.request.body).toEqual({
      timezone: 'Europe/Kyiv',
      slots: [{ weekday: 1, startMin: 1140, endMin: 1380 }],
      busyDates: [],
    });
    const saved = { ...empty, slots: [{ weekday: 1 as const, startMin: 1140, endMin: 1380 }] };
    put.flush(saved);
    await settle();
    // Пояс акаунта міг змінитися (R5) — оновлюємо /api/me.
    http.expectOne('/api/me').flush(me);
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
});
