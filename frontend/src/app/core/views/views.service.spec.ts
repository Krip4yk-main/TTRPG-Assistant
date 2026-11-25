import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { VIEWS_DEBOUNCE_MS, ViewsService } from './views.service';

describe('ViewsService', () => {
  let views: ViewsService;
  let http: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    views = TestBed.inject(ViewsService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  it('marks only new/updated items, debounced and merged per type', () => {
    const a = views.tracker('session');
    const b = views.tracker('session');
    a.track([
      { id: 1, seen: 'new' },
      { id: 2, seen: 'seen' },
    ]);
    b.track([
      { id: 3, seen: 'updated' },
      { id: 1, seen: 'new' },
    ]);
    http.expectNone('/api/me/views');
    vi.advanceTimersByTime(VIEWS_DEBOUNCE_MS);
    const req = http.expectOne('/api/me/views');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ entityType: 'session', ids: [1, 3] });
    req.flush(null, { status: 204, statusText: 'No Content' });
  });

  it('nothing new → no request', () => {
    views.tracker('game').track([{ id: 1, seen: 'seen' }]);
    vi.advanceTimersByTime(VIEWS_DEBOUNCE_MS);
    http.expectNone('/api/me/views');
  });

  it('splits batches by 100 ids', () => {
    views
      .tracker('application')
      .track(Array.from({ length: 150 }, (_, i) => ({ id: i + 1, seen: 'new' as const })));
    vi.advanceTimersByTime(VIEWS_DEBOUNCE_MS);
    const reqs = http.match('/api/me/views');
    expect(reqs.map((r) => (r.request.body as { ids: number[] }).ids.length)).toEqual([100, 50]);
    reqs.forEach((r) => r.flush(null));
  });

  it('badges stay visible for the current view even after the list is re-read as seen', () => {
    const t = views.tracker('game');
    t.track([
      { id: 1, seen: 'new' },
      { id: 2, seen: 'updated' },
      { id: 3, seen: 'seen' },
    ]);
    t.track([
      { id: 1, seen: 'seen' },
      { id: 2, seen: 'seen' },
    ]);
    expect([t.badge(1), t.badge(2), t.badge(3)]).toEqual(['new', 'updated', null]);
    vi.advanceTimersByTime(VIEWS_DEBOUNCE_MS);
    http.expectOne('/api/me/views').flush(null);
  });

  it('a failed request is not fatal', () => {
    views.tracker('game').track([{ id: 1, seen: 'new' }]);
    vi.advanceTimersByTime(VIEWS_DEBOUNCE_MS);
    http.expectOne('/api/me/views').flush(null, { status: 500, statusText: 'Server Error' });
  });
});
