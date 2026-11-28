import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { AdminRatingDto, MeDto } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';
import { AdminRatings } from './ratings';

const me = {
  id: 1,
  publicId: 'abcdefghjk',
  nickname: 'Mod',
  avatarUrl: null,
  birthDate: '1990-01-01',
  role: 'moderator',
  status: 'active',
  timezone: 'Europe/Kyiv',
  locale: 'uk',
  uiTheme: 'quest-board',
  availableThemes: ['quest-board'],
  uiPrefs: { tearAnimation: true, sendAnimation: true },
  myLimits: [],
  defaultView: 'player',
  avatarSource: 'auto',
  customAvatarUrl: null,
  avatarOptions: [],
  identities: [],
} satisfies MeDto;

const rating: AdminRatingDto = {
  id: 31,
  rater: { publicId: 'rater00001', nickname: 'Ярема', role: 'user' },
  ratee: { publicId: 'ratee00001', nickname: 'Гендальф', role: 'user' },
  game: { id: 7, title: 'Туман' },
  sessionId: null,
  kind: 'final',
  role: 'gm',
  overall: 1,
  criteria: { preparation: 1 },
  comment: 'Жахливо',
  moderated: 'none',
  createdAt: '2026-11-24T10:00:00.000Z',
};

describe('AdminRatings', () => {
  let fixture: ComponentFixture<AdminRatings>;
  let http: HttpTestingController;
  let el: HTMLElement;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const overlay = () => document.querySelector<HTMLElement>('.cdk-overlay-container')!;
  const clearOverlay = () =>
    document.querySelectorAll('.cdk-overlay-container').forEach((c) => (c.innerHTML = ''));

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminRatings],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            on: () => new Subject(),
            connected$: new Subject(),
            sessionLost$: new Subject(),
          },
        },
      ],
    }).compileComponents();
    TestBed.inject(AuthStore).setMe(me);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AdminRatings);
    el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle();
    const req = http.expectOne((r) => r.url === '/api/admin/ratings');
    expect(req.request.params.get('filter')).toBe('new');
    req.flush({ items: [rating], nextCursor: null });
    await settle();
  });

  afterEach(() => {
    http.verify();
    el.remove();
    clearOverlay();
  });

  const typeReason = async (value: string) => {
    const area = overlay().querySelector<HTMLTextAreaElement>('textarea.text')!;
    area.value = value;
    area.dispatchEvent(new Event('input'));
    await settle();
  };

  it('shows both sides, the game, the scores and the text', () => {
    const item = el.querySelector('[data-rating="31"]')!;
    expect(item.textContent).toContain('Ярема');
    expect(item.textContent).toContain('Гендальф');
    expect(item.textContent).toContain('Туман');
    expect(item.querySelector('.comment')!.textContent).toContain('Жахливо');
  });

  it('cancelling a rating asks for confirmation with a reason; dismissing the dialog sends nothing', async () => {
    el.querySelector<HTMLButtonElement>('button.cancel-rating')!.click();
    await settle();
    expect(overlay().querySelector('h2')!.textContent).toContain('admin.ratings.cancelTitle');
    expect(overlay().textContent).toContain('admin.ratings.cancelText');
    // Без причини — нічого не надсилається.
    overlay().querySelector<HTMLButtonElement>('button.confirm')!.click();
    await settle();
    http.expectNone('/api/admin/ratings/31/cancel');
    expect(overlay().textContent).toContain('admin.reasonRequired');
    // «Скасувати» в діалозі — оцінка лишається.
    [...overlay().querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent!.includes('common.cancel'))!
      .click();
    await settle();
    http.expectNone('/api/admin/ratings/31/cancel');
    expect(el.querySelector('[data-rating="31"]')).not.toBeNull();
  });

  it('confirmed cancellation sends the reason and removes the rating from the queue', async () => {
    el.querySelector<HTMLButtonElement>('button.cancel-rating')!.click();
    await settle();
    await typeReason('  Образи  ');
    overlay().querySelector<HTMLButtonElement>('button.confirm')!.click();
    await settle();
    const req = http.expectOne('/api/admin/ratings/31/cancel');
    expect(req.request.body).toEqual({ reason: 'Образи' });
    req.flush({ ...rating, moderated: 'cancelled' });
    // Діалог закривається з анімацією — чекаємо, доки оцінка зникне з черги.
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('[data-rating="31"]')).toBeNull();
    });
  });

  it('hiding the text also needs a reason and confirmation', async () => {
    el.querySelector<HTMLButtonElement>('button.hide-text')!.click();
    await settle();
    expect(overlay().querySelector('h2')!.textContent).toContain('admin.ratings.hideTitle');
    await typeReason('Лайка');
    overlay().querySelector<HTMLButtonElement>('button.confirm')!.click();
    await settle();
    http
      .expectOne('/api/admin/ratings/31/hide-text')
      .flush({ ...rating, comment: null, moderated: 'text_hidden' });
    // Діалог закривається з анімацією — чекаємо, доки оцінка зникне з черги.
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('[data-rating="31"]')).toBeNull();
    });
  });
});
