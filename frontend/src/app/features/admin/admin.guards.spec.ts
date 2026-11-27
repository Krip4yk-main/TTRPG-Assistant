import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import {
  type CanActivateFn,
  Router,
  UrlTree,
  provideRouter,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';
import { Subject } from 'rxjs';
import type { MeDto, UserRole } from '@nri/shared';
import { AuthStore } from '../../core/auth/auth.store';
import { SocketService } from '../../core/realtime/socket.service';
import { staffGuard } from './admin.guards';
import { ADMIN_ROUTES } from './admin.routes';

const me = (role: UserRole): MeDto => ({
  id: 1,
  publicId: 'abcdefghjk',
  nickname: 'Frodo',
  avatarUrl: null,
  birthDate: '1990-01-01',
  role,
  status: 'active',
  timezone: 'Europe/Kyiv',
  locale: 'uk',
  uiTheme: 'quest-board',
  availableThemes: ['quest-board'],
  uiPrefs: { tearAnimation: true, sendAnimation: true },
  avatarSource: 'auto',
  customAvatarUrl: null,
  avatarOptions: [],
  identities: [],
});

describe('staffGuard', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
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
    });
  });

  const run = (min: UserRole, url = '/admin/complaints') =>
    TestBed.runInInjectionContext(() =>
      staffGuard(min)({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot),
    );
  const path = (result: unknown) => TestBed.inject(Router).serializeUrl(result as UrlTree);

  it('a plain user has no access: redirected home', async () => {
    TestBed.inject(AuthStore).setMe(me('user'));
    const result = await run('moderator');
    expect(result).toBeInstanceOf(UrlTree);
    expect(path(result)).toBe('/');
  });

  it.each(['moderator', 'admin', 'owner'] as const)(
    '%s may open the admin section',
    async (role) => {
      TestBed.inject(AuthStore).setMe(me(role));
      expect(await run('moderator')).toBe(true);
    },
  );

  it('a moderator opening an admin-only tab goes back to the admin section', async () => {
    TestBed.inject(AuthStore).setMe(me('moderator'));
    expect(path(await run('admin', '/admin/log'))).toBe('/admin');
  });

  it('admin and owner may open admin-only tabs', async () => {
    TestBed.inject(AuthStore).setMe(me('admin'));
    expect(await run('admin', '/admin/roles')).toBe(true);
  });

  it('a guest is sent to login with returnTo', async () => {
    TestBed.inject(AuthStore).setMe(null);
    expect(path(await run('moderator'))).toBe('/login?returnTo=%2Fadmin%2Fcomplaints');
  });

  it('the catalog tab is admin-only; dead games are open to moderators', async () => {
    const child = (p: string) => ADMIN_ROUTES[0]!.children!.find((r) => r.path === p)!;
    expect(child('dead-games').canActivate).toBeUndefined();
    const guard = child('catalog').canActivate![0] as CanActivateFn;
    const check = () =>
      TestBed.runInInjectionContext(() =>
        guard({} as ActivatedRouteSnapshot, { url: '/admin/catalog' } as RouterStateSnapshot),
      );
    TestBed.inject(AuthStore).setMe(me('moderator'));
    expect(path(await check())).toBe('/admin');
    TestBed.inject(AuthStore).setMe(me('admin'));
    expect(await check()).toBe(true);
  });
});
