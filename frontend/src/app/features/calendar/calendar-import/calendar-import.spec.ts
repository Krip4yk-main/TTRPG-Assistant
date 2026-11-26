import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import type { CalendarImportStatusDto, MeDto } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { CalendarImport } from './calendar-import';

const status = (patch: Partial<CalendarImportStatusDto> = {}): CalendarImportStatusDto => ({
  available: true,
  connected: false,
  host: null,
  lastSyncAt: null,
  lastAttemptAt: null,
  lastError: null,
  failures: 0,
  broken: false,
  eventsCount: 0,
  truncated: false,
  nextManualSyncAt: null,
  ...patch,
});

const connected = (patch: Partial<CalendarImportStatusDto> = {}) =>
  status({
    connected: true,
    host: 'calendar.google.com',
    lastSyncAt: '2026-11-26T10:00:00.000Z',
    lastAttemptAt: '2026-11-26T10:00:00.000Z',
    eventsCount: 12,
    ...patch,
  });

const URL = '/api/me/calendar-import';

describe('CalendarImport', () => {
  let fixture: ComponentFixture<CalendarImport>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let confirm: boolean;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function open(initial: CalendarImportStatusDto) {
    confirm = true;
    await TestBed.configureTestingModule({
      imports: [CalendarImport],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: MatDialog, useValue: { open: () => ({ afterClosed: () => of(confirm) }) } },
      ],
    }).compileComponents();
    TestBed.inject(AuthStore).setMe({ id: 2, timezone: 'Europe/Kyiv' } as MeDto);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CalendarImport);
    el = fixture.nativeElement as HTMLElement;
    await settle();
    http.expectOne(URL).flush(initial);
    await settle();
  }

  const type = async (value: string) => {
    const input = el.querySelector<HTMLInputElement>('input.url')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  };
  const submit = async () => {
    el.querySelector<HTMLButtonElement>('button.connect-btn')!.click();
    await settle();
  };
  const alert = () => el.querySelector('[role="alert"]')?.textContent ?? '';

  afterEach(() => http.verify());

  it('not connected: link field with help for Google / Apple / Outlook; PUT on submit', async () => {
    await open(status());
    expect(el.querySelector('label[for="calendar-import-url"]')).not.toBeNull();
    const help = el.querySelector('details.help')!;
    expect(help.textContent).toContain('calendar.import.help.google');
    expect(help.textContent).toContain('calendar.import.help.apple');
    expect(help.textContent).toContain('calendar.import.help.outlook');
    await submit();
    expect(alert()).toContain('calendar.import.urlRequired');
    await type('  webcal://p01.icloud.com/x  ');
    await submit();
    const req = http.expectOne(URL);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ url: 'webcal://p01.icloud.com/x' });
    req.flush(connected());
    await settle();
    // Показується лише хост, саме посилання — ніде.
    expect(el.textContent).toContain('calendar.import.connectedTo');
    expect(el.textContent).not.toContain('icloud.com/x');
    expect(el.querySelector('input.url')).toBeNull();
  });

  it('422 with a reason shows the human text for that reason', async () => {
    await open(status());
    await type('https://example.com/cal.ics');
    await submit();
    http
      .expectOne(URL)
      .flush(
        { error: { code: 'CALENDAR_IMPORT_FAILED', details: { reason: 'not_calendar' } } },
        { status: 422, statusText: 'x' },
      );
    await settle();
    expect(alert()).toContain('calendar.import.errors.not_calendar');
  });

  it('busy server (429 reason busy) and the PUT rate limit have separate texts', async () => {
    await open(status());
    await type('https://example.com/cal.ics');
    await submit();
    http
      .expectOne(URL)
      .flush(
        { error: { code: 'RATE_LIMITED', details: { retryAfterSec: 30, reason: 'busy' } } },
        { status: 429, statusText: 'x' },
      );
    await settle();
    expect(alert()).toContain('calendar.import.busy');
    await submit();
    http
      .expectOne(URL)
      .flush({ error: { code: 'RATE_LIMITED' } }, { status: 429, statusText: 'x' });
    await settle();
    expect(alert()).toContain('errors.RATE_LIMITED');
  });

  it('connected: last sync, error, broken and truncated states', async () => {
    await open(connected({ lastError: 'http_gone', failures: 5, broken: true, truncated: true }));
    expect(el.querySelector('.broken-text')!.textContent).toContain('calendar.import.broken');
    expect(el.querySelector('.last-error')!.textContent).toContain(
      'calendar.import.errors.http_gone',
    );
    expect(el.querySelector('.truncated')!.textContent).toContain('calendar.import.truncated');
    expect(el.textContent).toContain('calendar.import.lastSync');
  });

  it('sync now: failure in lastError, 429 with retryAfterSec, locked until nextManualSyncAt', async () => {
    await open(connected());
    el.querySelector<HTMLButtonElement>('button.sync')!.click();
    const req = http.expectOne(`${URL}/sync`);
    expect(req.request.method).toBe('POST');
    req.flush(connected({ lastError: 'timeout', failures: 1 }));
    await settle();
    expect(alert()).toContain('calendar.import.errors.timeout');

    fixture.componentInstance['status'].set(connected());
    await settle();
    el.querySelector<HTMLButtonElement>('button.sync')!.click();
    http
      .expectOne(`${URL}/sync`)
      .flush(
        { error: { code: 'RATE_LIMITED', details: { retryAfterSec: 200 } } },
        { status: 429, statusText: 'x' },
      );
    await settle();
    expect(alert()).toContain('calendar.import.rateLimited');

    fixture.componentInstance['status'].set(
      connected({ nextManualSyncAt: new Date(Date.now() + 120_000).toISOString() }),
    );
    await settle();
    expect(el.querySelector<HTMLButtonElement>('button.sync')!.disabled).toBe(true);
    expect(el.querySelector('#calendar-sync-hint')).not.toBeNull();
  });

  it('disconnect asks first, then DELETE and the form is back', async () => {
    await open(connected());
    confirm = false;
    el.querySelector<HTMLButtonElement>('button.disconnect')!.click();
    await settle();
    http.expectNone(URL);
    confirm = true;
    el.querySelector<HTMLButtonElement>('button.disconnect')!.click();
    await settle();
    const req = http.expectOne(URL);
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
    await settle();
    expect(el.querySelector('input.url')).not.toBeNull();
    expect(el.textContent).toContain('calendar.import.disconnected');
  });

  it('server without a key: explained, no form', async () => {
    await open(status({ available: false }));
    expect(el.querySelector('.unavailable')).not.toBeNull();
    expect(el.querySelector('input.url')).toBeNull();
  });
});
