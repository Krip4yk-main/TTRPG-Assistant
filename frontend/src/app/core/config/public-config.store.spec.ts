import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PublicConfigStore } from './public-config.store';
import { publicConfigGuard } from './public-config.guard';

describe('PublicConfigStore', () => {
  let http: HttpTestingController;
  let store: PublicConfigStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(PublicConfigStore);
  });
  afterEach(() => http.verify());

  it('is all off before loading', () => {
    expect(store.loaded()).toBe(false);
    expect(store.telegramBotUsername()).toBe('');
    expect(store.googleLogin()).toBe(false);
    expect(store.discordLogin()).toBe(false);
  });

  it('loads the config once and shares the request', async () => {
    const a = store.ensureLoaded();
    const b = store.ensureLoaded();
    http.expectOne('/api/public-config').flush({
      telegramBotUsername: 'nri_bot',
      providers: { telegram: true, google: false, discord: true },
    });
    await Promise.all([a, b]);
    expect(store.loaded()).toBe(true);
    expect(store.telegramBotUsername()).toBe('nri_bot');
    expect(store.telegramLogin()).toBe(true);
    expect(store.googleLogin()).toBe(false);
    expect(store.discordLogin()).toBe(true);
    await store.ensureLoaded();
    http.expectNone('/api/public-config');
  });

  it('stays off on a failed request and retries next time', async () => {
    const first = store.ensureLoaded();
    http.expectOne('/api/public-config').flush('x', { status: 500, statusText: 'x' });
    await first;
    expect(store.loaded()).toBe(false);
    expect(store.googleLogin()).toBe(false);
    const second = store.ensureLoaded();
    http.expectOne('/api/public-config').flush({
      telegramBotUsername: null,
      providers: { telegram: false, google: true, discord: false },
    });
    await second;
    expect(store.googleLogin()).toBe(true);
  });

  it('ignores a malformed response', async () => {
    const p = store.ensureLoaded();
    http.expectOne('/api/public-config').flush({ nope: 1 });
    await p;
    expect(store.loaded()).toBe(false);
    expect(store.googleLogin()).toBe(false);
  });

  it('guard waits for the config and lets the navigation through', async () => {
    const result = TestBed.runInInjectionContext(() => publicConfigGuard({} as never, {} as never));
    http.expectOne('/api/public-config').flush({
      telegramBotUsername: null,
      providers: { telegram: false, google: true, discord: false },
    });
    expect(await result).toBe(true);
    expect(store.googleLogin()).toBe(true);
  });
});
