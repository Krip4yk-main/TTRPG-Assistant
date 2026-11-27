import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { Clipboard } from '@angular/cdk/clipboard';
import { MatDialog } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import type { CalendarFeedStatusDto, MeDto } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { CalendarFeed } from './calendar-feed';

const API = '/api/me/calendar-feed';
const FEED_URL = 'https://example.test/api/cal/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde.ics';
const OFF: CalendarFeedStatusDto = { enabled: false, createdAt: null };
const ON: CalendarFeedStatusDto = { enabled: true, createdAt: '2026-11-20T10:00:00.000Z' };

describe('CalendarFeed', () => {
  let fixture: ComponentFixture<CalendarFeed>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let confirm: boolean;
  let dialogData: unknown[];
  const copied: string[] = [];
  const announced: string[] = [];

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function open(initial: CalendarFeedStatusDto) {
    confirm = true;
    dialogData = [];
    copied.length = 0;
    announced.length = 0;
    await TestBed.configureTestingModule({
      imports: [CalendarFeed],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        {
          provide: MatDialog,
          useValue: {
            open: (_c: unknown, cfg: { data: unknown }) => {
              dialogData.push(cfg.data);
              return { afterClosed: () => of(confirm) };
            },
          },
        },
        { provide: Clipboard, useValue: { copy: (t: string) => (copied.push(t), true) } },
        {
          provide: LiveAnnouncer,
          useValue: { announce: (m: string) => (announced.push(m), Promise.resolve()) },
        },
      ],
    }).compileComponents();
    TestBed.inject(AuthStore).setMe({ id: 2, timezone: 'Europe/Kyiv' } as MeDto);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CalendarFeed);
    el = fixture.nativeElement as HTMLElement;
    await settle();
    http.expectOne(API).flush(initial);
    await settle();
  }

  const btn = (cls: string) => el.querySelector<HTMLButtonElement>(`button.${cls}`);

  afterEach(() => http.verify());

  it('disabled: only «Підключити»; POST shows the link, copy button and instructions', async () => {
    await open(OFF);
    expect(el.textContent).toContain('calendar.feed.title');
    expect(btn('enable')).not.toBeNull();
    expect(btn('reissue')).toBeNull();
    expect(btn('disable')).toBeNull();
    expect(el.querySelector('input.feed-url')).toBeNull();

    btn('enable')!.click();
    const req = http.expectOne(API);
    expect(req.request.method).toBe('POST');
    req.flush({ url: FEED_URL, createdAt: '2026-11-27T10:00:00.000Z' });
    await settle();

    expect(el.querySelector<HTMLInputElement>('input.feed-url')!.value).toBe(FEED_URL);
    expect(btn('copy')).not.toBeNull();
    const help = el.querySelector('.instructions')!.textContent!;
    for (const k of ['google', 'apple', 'outlook', 'googleDelay']) {
      expect(help).toContain(`calendar.feed.help.${k}`);
    }
    expect(btn('reissue')).not.toBeNull();
    expect(btn('disable')).not.toBeNull();
  });

  it('copy puts the link into the clipboard and announces it', async () => {
    await open(OFF);
    btn('enable')!.click();
    http.expectOne(API).flush({ url: FEED_URL, createdAt: '2026-11-27T10:00:00.000Z' });
    await settle();
    btn('copy')!.click();
    await settle();
    expect(copied).toEqual([FEED_URL]);
    expect(announced).toEqual(['calendar.feed.copied']);
  });

  it('enabled after reload: «Підключено з <дата>» without the link; reissue asks first', async () => {
    await open(ON);
    expect(el.querySelector('.connected-since')!.textContent).toContain('calendar.feed.since');
    expect(el.querySelector('input.feed-url')).toBeNull();
    expect(btn('copy')).toBeNull();
    expect(btn('enable')).toBeNull();

    confirm = false;
    btn('reissue')!.click();
    await settle();
    http.expectNone(API);
    expect(JSON.stringify(dialogData[0])).toContain('calendar.feed.reissueConfirm.text');

    confirm = true;
    btn('reissue')!.click();
    await settle();
    const req = http.expectOne(API);
    expect(req.request.method).toBe('POST');
    req.flush({ url: FEED_URL, createdAt: '2026-11-27T10:00:00.000Z' });
    await settle();
    expect(el.querySelector<HTMLInputElement>('input.feed-url')!.value).toBe(FEED_URL);
  });

  it('disable asks first, then DELETE and back to «Підключити»', async () => {
    await open(ON);
    confirm = true;
    btn('disable')!.click();
    await settle();
    const req = http.expectOne(API);
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
    await settle();
    expect(btn('enable')).not.toBeNull();
    expect(el.querySelector('.connected-since')).toBeNull();
    expect(el.textContent).toContain('calendar.feed.disabled');
  });

  it('load error shows retry', async () => {
    confirm = true;
    await TestBed.configureTestingModule({
      imports: [CalendarFeed],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideTranslateService()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CalendarFeed);
    el = fixture.nativeElement as HTMLElement;
    await settle();
    http.expectOne(API).flush({ error: { code: 'INTERNAL' } }, { status: 500, statusText: 'x' });
    await settle();
    expect(el.textContent).toContain('calendar.feed.loadError');
  });
});
