import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { CalendarPin } from './calendar-pin';

describe('CalendarPin', () => {
  let fixture: ComponentFixture<CalendarPin>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const toggle = () => el().querySelector<HTMLButtonElement>('button[role=switch]');
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create(autoBusy: boolean, pinned: number[] = []) {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CalendarPin);
    fixture.componentRef.setInput('gameId', 7);
    await settle();
    http.expectOne('/api/me/settings').flush({ calendarAutoBusy: autoBusy });
    await settle();
    if (!autoBusy) {
      http.expectOne('/api/me/calendar/pinned-games').flush({ gameIds: pinned });
      await settle();
    }
  }

  afterEach(() => http.verify());

  it('auto mode: no toggle, only a hint', async () => {
    await create(true);
    expect(toggle()).toBeNull();
    expect(el().textContent).toContain('calendarPin.auto');
  });

  it('manual mode: the toggle adds and removes the game', async () => {
    await create(false, [3]);
    expect(toggle()!.getAttribute('aria-checked')).toBe('false');
    expect(el().textContent).toContain('calendarPin.label');

    toggle()!.click();
    await settle();
    const post = http.expectOne('/api/me/calendar/pinned-games/7');
    expect(post.request.method).toBe('POST');
    post.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    expect(toggle()!.getAttribute('aria-checked')).toBe('true');

    toggle()!.click();
    await settle();
    const del = http.expectOne('/api/me/calendar/pinned-games/7');
    expect(del.request.method).toBe('DELETE');
    del.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    expect(toggle()!.getAttribute('aria-checked')).toBe('false');
  });

  it('a failed request reverts the toggle and shows the error', async () => {
    await create(false, [7]);
    expect(toggle()!.getAttribute('aria-checked')).toBe('true');
    toggle()!.click();
    await settle();
    http
      .expectOne('/api/me/calendar/pinned-games/7')
      .flush({ error: { code: 'NOT_A_MEMBER' } }, { status: 403, statusText: 'Forbidden' });
    await settle();
    expect(toggle()!.getAttribute('aria-checked')).toBe('true');
    expect(el().querySelector('[role=alert]')!.textContent).toContain('errors.NOT_A_MEMBER');
  });

  it('ignores a stale response after the game changes', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CalendarPin);
    fixture.componentRef.setInput('gameId', 7);
    await settle();
    fixture.componentRef.setInput('gameId', 8);
    await settle();
    const [stale, fresh] = http.match('/api/me/settings');
    fresh!.flush({ calendarAutoBusy: true });
    await settle();
    stale!.flush({ calendarAutoBusy: false });
    await settle();
    http.expectNone('/api/me/calendar/pinned-games');
    expect(toggle()).toBeNull();
    expect(el().textContent).toContain('calendarPin.auto');
  });
});
