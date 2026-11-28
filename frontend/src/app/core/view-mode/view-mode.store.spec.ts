import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { MeDto, ViewMode } from '@nri/shared';
import { AuthStore } from '../auth/auth.store';
import { ViewModeStore } from './view-mode.store';

const KEY = 'nri.viewMode';

function me(id: number, defaultView: ViewMode = 'player'): MeDto {
  return { id, status: 'active', defaultView } as unknown as MeDto;
}

/** Замість AuthStore: лише стан профілю (без HTTP і сокета). */
class FakeAuth {
  private readonly state = signal<MeDto | null>(null);
  readonly me = this.state.asReadonly();
  readonly isActive = computed(() => this.state()?.status === 'active');
  setMe(user: MeDto | null): void {
    this.state.set(user);
  }
}

/** Нова «вкладка»: свіжий інжектор, sessionStorage лишається (як після перезавантаження). */
function reopen(user: MeDto | null): ViewModeStore {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: AuthStore, useClass: FakeAuth }] });
  TestBed.inject(AuthStore).setMe(user);
  return TestBed.inject(ViewModeStore);
}

describe('ViewModeStore', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => vi.restoreAllMocks());

  it("гість — завжди 'player', навіть після setMode('gm')", () => {
    const store = reopen(null);
    expect(store.mode()).toBe('player');
    store.setMode('gm');
    expect(store.mode()).toBe('player');
  });

  it('нова вкладка — вид за замовчуванням з профілю', () => {
    expect(reopen(me(1)).mode()).toBe('player');
    expect(reopen(me(2, 'gm')).mode()).toBe('gm');
  });

  it('вид з’являється, щойно профіль завантажився (до того — гравець)', () => {
    const store = reopen(null);
    expect(store.mode()).toBe('player');
    TestBed.inject(AuthStore).setMe(me(1, 'gm'));
    expect(store.mode()).toBe('gm');
  });

  it('обраний вид зберігається в sessionStorage вкладки (не в localStorage) і переживає перезавантаження', () => {
    reopen(me(1)).setMode('gm');
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(sessionStorage.getItem(KEY)).not.toBeNull();
    expect(reopen(me(1)).mode()).toBe('gm');
  });

  it('обраний у вкладці вид важливіший за вид за замовчуванням', () => {
    reopen(me(1, 'gm')).setMode('player');
    expect(reopen(me(1, 'gm')).mode()).toBe('player');
  });

  it('зміна виду за замовчуванням не перемикає відкриту вкладку (і після перезавантаження)', () => {
    const store = reopen(me(1, 'player'));
    expect(store.mode()).toBe('player'); // каркас читає вид одразу при показі
    TestBed.inject(AuthStore).setMe(me(1, 'gm'));
    expect(store.mode()).toBe('player');
    expect(reopen(me(1, 'gm')).mode()).toBe('player');
  });

  it('вид іншого користувача у вкладці не застосовується (вихід / вхід іншим)', () => {
    reopen(me(1)).setMode('gm');
    const store = reopen(me(2));
    expect(store.mode()).toBe('player');
    TestBed.inject(AuthStore).setMe(null);
    expect(store.mode()).toBe('player');
    TestBed.inject(AuthStore).setMe(me(3, 'gm'));
    expect(store.mode()).toBe('gm');
  });

  it('ігнорує некоректне значення в sessionStorage і старий ключ у localStorage', () => {
    sessionStorage.setItem(KEY, 'admin');
    localStorage.setItem(KEY, 'gm');
    expect(reopen(me(1)).mode()).toBe('player');
    sessionStorage.setItem(KEY, JSON.stringify({ u: 1, m: 'admin' }));
    expect(reopen(me(1)).mode()).toBe('player');
  });

  it('якщо сховище кидає — працює в пам’яті без помилки', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    const store = reopen(me(1));
    expect(store.mode()).toBe('player');
    expect(() => store.setMode('gm')).not.toThrow();
    expect(store.mode()).toBe('gm');
  });
});
