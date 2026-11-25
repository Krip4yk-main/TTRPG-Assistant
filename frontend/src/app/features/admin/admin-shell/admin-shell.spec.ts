import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { MeDto, UserRole } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';
import { AdminShell } from './admin-shell';

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
  uiPrefs: { tearAnimation: true },
  identities: [],
});

describe('AdminShell', () => {
  async function tabsFor(role: UserRole): Promise<string[]> {
    await TestBed.configureTestingModule({
      imports: [AdminShell],
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
    TestBed.inject(AuthStore).setMe(me(role));
    const fixture = TestBed.createComponent(AdminShell);
    fixture.detectChanges();
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    return [...el.querySelectorAll('a[mat-tab-link]')].map((a) => a.getAttribute('data-tab')!);
  }

  it('a moderator sees complaints, users, appeals, ratings and dead games — no roles, catalog or log', async () => {
    expect(await tabsFor('moderator')).toEqual([
      'complaints',
      'users',
      'appeals',
      'ratings',
      'dead-games',
    ]);
  });

  it.each(['admin', 'owner'] as const)(
    '%s also sees roles, the catalog and the log',
    async (role) => {
      expect(await tabsFor(role)).toEqual([
        'complaints',
        'users',
        'appeals',
        'ratings',
        'dead-games',
        'roles',
        'catalog',
        'log',
      ]);
    },
  );
});
