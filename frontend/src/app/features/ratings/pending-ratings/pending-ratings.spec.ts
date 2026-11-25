import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import type { MeDto, RatingTargetsDto } from '@nri/shared';
import { PendingRatings } from './pending-ratings';
import { AuthStore } from '../../../core/auth/auth.store';

const me = {
  id: 1,
  publicId: 'abcdefghjk',
  nickname: 'Frodo',
  avatarUrl: null,
  birthDate: '1990-01-01',
  role: 'user',
  status: 'active',
  timezone: 'Europe/Kyiv',
  locale: 'uk',
  identities: [],
} satisfies MeDto;

const sets: RatingTargetsDto[] = [
  {
    gameId: 7,
    sessionId: 9,
    kind: 'session',
    targets: [
      {
        publicId: 'gggggggggg',
        nickname: 'Gandalf',
        avatarUrl: null,
        role: 'gm',
        state: 'open',
        closesAt: '2026-12-04T10:00:00.000Z',
      },
      {
        publicId: 'pppppppppp',
        nickname: 'Sam',
        avatarUrl: null,
        role: 'player_from_player',
        state: 'rated',
        closesAt: '2026-12-04T10:00:00.000Z',
      },
    ],
  },
  {
    gameId: 8,
    sessionId: null,
    kind: 'final',
    targets: [
      {
        publicId: 'mmmmmmmmmm',
        nickname: 'Merry',
        avatarUrl: null,
        role: 'player_from_player',
        state: 'open',
        closesAt: null,
      },
    ],
  },
];

describe('PendingRatings', () => {
  let fixture: ComponentFixture<PendingRatings>;
  let http: HttpTestingController;
  let el: HTMLElement;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create() {
    await TestBed.configureTestingModule({
      imports: [PendingRatings],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
      ],
    }).compileComponents();
    TestBed.inject(AuthStore).setMe(me);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PendingRatings);
    el = fixture.nativeElement as HTMLElement;
    await settle();
  }

  afterEach(() => http.verify());

  const set = (key: string) => el.querySelector<HTMLElement>(`[data-set="${key}"]`)!;

  it('lists sets with open targets, deadlines and links to the rate page', async () => {
    await create();
    http.expectOne('/api/me/ratings/pending').flush(sets);
    await settle();
    http.expectOne('/api/games/7').flush({ id: 7, title: 'Туман над Дніпром' });
    http.expectOne('/api/games/8').flush({}, { status: 500, statusText: 'Server Error' });
    await settle();

    expect(set('7:9').querySelector('.game')!.textContent).toContain('Туман над Дніпром');
    expect(set('7:9').textContent).toContain('ratings.pending.session');
    expect(set('7:9').textContent).toContain('ratings.closes.until');
    expect(set('7:9').querySelector('a.rate')!.getAttribute('href')).toBe(
      '/games/7/rate?session=9',
    );
    // Без назви (збій) — «Гра №8»; підсумкова без дедлайну, поки гра йде.
    expect(set('8:final').querySelector('.game')!.textContent).toContain('ratings.pending.game');
    expect(set('8:final').textContent).toContain('ratings.pending.final');
    expect(set('8:final').textContent).toContain('ratings.closes.none');
    expect(set('8:final').querySelector('a.rate')!.getAttribute('href')).toBe('/games/8/rate');
  });

  it('empty: nothing to rate right now', async () => {
    await create();
    http.expectOne('/api/me/ratings/pending').flush([]);
    await settle();
    expect(el.querySelector('.empty')!.textContent).toContain('ratings.pending.empty');
  });

  it('load error offers a retry', async () => {
    await create();
    http.expectOne('/api/me/ratings/pending').flush({}, { status: 500, statusText: 'Error' });
    await settle();
    expect(el.querySelector('.load-error')).not.toBeNull();
    el.querySelector<HTMLButtonElement>('.load-error button')!.click();
    await settle();
    http.expectOne('/api/me/ratings/pending').flush([]);
    await settle();
    expect(el.querySelector('.empty')).not.toBeNull();
  });
});
