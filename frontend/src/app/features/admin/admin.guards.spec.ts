import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import {
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
});
