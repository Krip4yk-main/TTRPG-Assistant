import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { alternatives, session } from '../scheduling-testing';
import { SessionAlternativesDialog } from './session-alternatives-dialog';

describe('SessionAlternativesDialog', () => {
  let fixture: ComponentFixture<SessionAlternativesDialog>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let close: ReturnType<typeof vi.fn>;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    close = vi.fn();
    await TestBed.configureTestingModule({
      imports: [SessionAlternativesDialog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: MAT_DIALOG_DATA, useValue: { sessionId: 41, viewerTimezone: 'Europe/Kyiv' } },
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(SessionAlternativesDialog);
    el = fixture.nativeElement as HTMLElement;
    await settle();
  });

  afterEach(() => http.verify());

  const items = () => [...el.querySelectorAll<HTMLElement>('li.candidate')];

  it('shows alternatives with statuses and reschedules in one click', async () => {
    http.expectOne('/api/sessions/41/alternatives').flush(alternatives());
    await settle();
    expect(el.querySelector('.current')!.textContent).toContain('scheduling.alternatives.current');
    expect(items().length).toBe(2);
    expect(items()[0]!.querySelectorAll('nri-participant-statuses li').length).toBe(3);
    // 2030-03-08T17:00Z = пт, 19:00 у Києві.
    expect(items()[0]!.textContent).toContain('19:00');
    items()[0]!.querySelector<HTMLButtonElement>('button.move')!.click();
    const req = http.expectOne('/api/sessions/41/reschedule');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ startsAt: '2030-03-08T17:00:00.000Z' });
    const moved = session({ startsAt: '2030-03-08T17:00:00.000Z', rescheduled: true });
    req.flush(moved);
    await settle();
    expect(close).toHaveBeenCalledWith(moved);
  });

  it('a past / rescheduled session (409) explains instead of listing', async () => {
    http
      .expectOne('/api/sessions/41/alternatives')
      .flush({ error: { code: 'SESSION_INVALID_STATE' } }, { status: 409, statusText: 'x' });
    await settle();
    expect(el.querySelector('.stale')!.textContent).toContain('scheduling.alternatives.stale');
    expect(items().length).toBe(0);
  });

  it('the session changed meanwhile: reschedule 409 shows the same fallback', async () => {
    http.expectOne('/api/sessions/41/alternatives').flush(alternatives());
    await settle();
    items()[1]!.querySelector<HTMLButtonElement>('button.move')!.click();
    http
      .expectOne('/api/sessions/41/reschedule')
      .flush({ error: { code: 'SESSION_INVALID_STATE' } }, { status: 409, statusText: 'x' });
    await settle();
    expect(el.querySelector('.stale')).not.toBeNull();
    expect(close).not.toHaveBeenCalled();
  });

  it('empty calendars and empty lists get their own hints', async () => {
    http
      .expectOne('/api/sessions/41/alternatives')
      .flush(alternatives({ noCalendars: true, alternatives: [] }));
    await settle();
    expect(el.querySelector('.no-calendars')).not.toBeNull();
    fixture.componentInstance['result'].set(alternatives({ alternatives: [] }));
    await settle();
    expect(el.querySelector('.empty')!.textContent).toContain('scheduling.alternatives.empty');
  });

  it('other errors offer a retry (403 for a non-GM is not "stale")', async () => {
    http
      .expectOne('/api/sessions/41/alternatives')
      .flush({ error: { code: 'FORBIDDEN' } }, { status: 403, statusText: 'x' });
    await settle();
    expect(el.querySelector('.stale')).toBeNull();
    el.querySelector<HTMLButtonElement>('.load-error button')!.click();
    http.expectOne('/api/sessions/41/alternatives').flush(alternatives());
    await settle();
    expect(items().length).toBe(2);
  });
});
