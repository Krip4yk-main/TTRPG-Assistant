import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { CatalogDto } from '@nri/shared';
import { CatalogStore } from './catalog.store';
import uk from '../../../assets/i18n/uk.json';

export const catalogFixture: CatalogDto = {
  systems: [
    { id: 1, slug: 'dnd5e-2014', name: 'D&D 5e (2014)', defaultGenreId: 10 },
    { id: 2, slug: 'coc7e', name: 'Call of Cthulhu 7e', defaultGenreId: 11 },
  ],
  genres: [
    { id: 10, slug: 'fantasy' },
    { id: 11, slug: 'horror' },
    { id: 12, slug: 'dark-fantasy' },
    { id: 13, slug: 'cyberpunk' },
    { id: 14, slug: 'scifi' },
    { id: 15, slug: 'postapoc' },
    { id: 16, slug: 'steampunk' },
    { id: 17, slug: 'noir' },
    { id: 18, slug: 'historical' },
    { id: 19, slug: 'superhero' },
    { id: 20, slug: 'comedy' },
  ],
  contentWarnings: [
    'violence',
    'gore',
    'character-death',
    'self-harm',
    'sexual-content',
    'drugs',
    'phobias',
    'abuse',
    'discrimination',
    'body-horror',
  ].map((slug, i) => ({ id: i + 1, slug })),
};

describe('CatalogStore', () => {
  let store: CatalogStore;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    store = TestBed.inject(CatalogStore);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('loads once and exposes the catalog', async () => {
    expect(store.catalog()).toBeNull();
    const first = store.load();
    const second = store.load();
    http.expectOne('/api/catalog').flush(catalogFixture);
    await Promise.all([first, second]);
    await store.load();
    expect(store.catalog()).toEqual(catalogFixture);
  });

  it('resolves system names and genre translation keys', async () => {
    const p = store.load();
    http.expectOne('/api/catalog').flush(catalogFixture);
    await p;
    expect(store.systemName(2)).toBe('Call of Cthulhu 7e');
    expect(store.systemName(999)).toBeNull();
    expect(store.genreKey(11)).toBe('genres.horror');
    expect(store.genreKey(999)).toBeNull();
  });

  it('allows retry after a failed load', async () => {
    const p = store.load().catch(() => 'failed');
    http.expectOne('/api/catalog').flush('x', { status: 500, statusText: 'err' });
    expect(await p).toBe('failed');
    const p2 = store.load();
    http.expectOne('/api/catalog').flush(catalogFixture);
    await p2;
    expect(store.catalog()).not.toBeNull();
  });

  it('invalidate() makes the next load refetch while keeping the current data', async () => {
    const p = store.load();
    http.expectOne('/api/catalog').flush(catalogFixture);
    await p;
    store.invalidate();
    expect(store.catalog()).toEqual(catalogFixture);
    const p2 = store.load();
    const fresh = { ...catalogFixture, systems: [] };
    http.expectOne('/api/catalog').flush(fresh);
    await p2;
    expect(store.catalog()).toEqual(fresh);
    await store.load();
  });

  it('uk.json has a translation for every genre, warning label and hint', () => {
    const t = uk as unknown as {
      genres: Record<string, string>;
      warnings: Record<string, { label?: string; hint?: string }>;
    };
    for (const g of catalogFixture.genres) expect(t.genres[g.slug], g.slug).toBeTruthy();
    for (const w of catalogFixture.contentWarnings) {
      expect(t.warnings[w.slug]?.label, `${w.slug}.label`).toBeTruthy();
      expect(t.warnings[w.slug]?.hint, `${w.slug}.hint`).toBeTruthy();
    }
  });
});
