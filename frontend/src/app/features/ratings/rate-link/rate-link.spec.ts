import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { NOTIFICATION_NEW_EVENT, type MeDto, type RatingTargetsDto } from '@nri/shared';
import { NAVIGATION_REFRESH_MS, RateLink } from './rate-link';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';

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
  uiTheme: 'quest-board',
  availableThemes: ['quest-board'],
  uiPrefs: { tearAnimation: true, sendAnimation: true },
  myLimits: [],
  avatarSource: 'auto',
  customAvatarUrl: null,
  avatarOptions: [],
  identities: [],
} satisfies MeDto;

const set = (states: ('open' | 'rated')[]): RatingTargetsDto => ({
  gameId: 7,
  gameTitle: 'Гра',
  sessionId: null,
  sessionStartsAt: null,
  kind: 'final',
  targets: states.map((state, i) => ({
    publicId: `user${i}aaaaa`,
    nickname: `U${i}`,
    avatarUrl: null,
    role: 'player_from_player',
    state,
    closesAt: null,
  })),
});

describe('RateLink', () => {
  let fixture: ComponentFixture<RateLink>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let notifications: Subject<unknown>;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const pending = () => http.expectOne('/api/me/ratings/pending');

  beforeEach(async () => {
    notifications = new Subject();
    await TestBed.configureTestingModule({
      imports: [RateLink],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: '**', children: [] }]),
        provideTranslateService(),
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            on: (ev: string) => (ev === NOTIFICATION_NEW_EVENT ? notifications : new Subject()),
            connected$: new Subject(),
            sessionLost$: new Subject(),
          },
        },
      ],
    }).compileComponents();
    TestBed.inject(AuthStore).setMe(me);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(RateLink);
    el = fixture.nativeElement as HTMLElement;
    await settle();
  });

  afterEach(() => http.verify());

  it('hidden while there is nothing to rate', async () => {
    pending().flush([set(['rated'])]);
    await settle();
    expect(el.querySelector('a')).toBeNull();
  });

  it('shows "Rate" with the number of open targets, linking to /ratings', async () => {
    pending().flush([set(['open', 'rated']), set(['open', 'open'])]);
    await settle();
    const a = el.querySelector<HTMLAnchorElement>('a.rate-link')!;
    expect(a.getAttribute('href')).toBe('/ratings');
    expect(a.querySelector('.count')!.textContent).toContain('3');
    expect(a.getAttribute('aria-label')).toBe('ratings.link.aria');
  });

  it('navigation refreshes at most once a minute; a new notification always', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    pending().flush([]);
    await settle();
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/games/1');
    await settle();
    http.expectNone('/api/me/ratings/pending');

    now.mockReturnValue(1_000_000 + NAVIGATION_REFRESH_MS);
    await router.navigateByUrl('/games/2');
    await settle();
    pending().flush([set(['open'])]);
    await settle();
    expect(el.querySelector('a.rate-link')).not.toBeNull();

    notifications.next({ id: 5 });
    await settle();
    pending().flush([]);
    await settle();
    expect(el.querySelector('a.rate-link')).toBeNull();
    now.mockRestore();
  });
});
