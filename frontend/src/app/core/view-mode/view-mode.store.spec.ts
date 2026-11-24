import { TestBed } from '@angular/core/testing';
import { ViewModeStore } from './view-mode.store';

describe('ViewModeStore', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  afterEach(() => vi.restoreAllMocks());

  it("за замовчуванням 'player'", () => {
    expect(TestBed.inject(ViewModeStore).mode()).toBe('player');
  });

  it("setMode('gm') → mode()==='gm' і значення зберігається між запусками", () => {
    TestBed.inject(ViewModeStore).setMode('gm');
    expect(TestBed.inject(ViewModeStore).mode()).toBe('gm');

    TestBed.resetTestingModule();
    expect(TestBed.inject(ViewModeStore).mode()).toBe('gm');
  });

  it('ігнорує некоректне значення в localStorage', () => {
    localStorage.setItem('nri.viewMode', 'admin');
    expect(TestBed.inject(ViewModeStore).mode()).toBe('player');
  });

  it('якщо localStorage кидає — працює з дефолтом без помилки', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    const store = TestBed.inject(ViewModeStore);
    expect(store.mode()).toBe('player');
    expect(() => store.setMode('gm')).not.toThrow();
    expect(store.mode()).toBe('gm');
  });
});
