import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { ComplaintDto, MeDto, UserRole } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';
import { AdminComplaints } from './complaints';

const me = (role: UserRole): MeDto => ({
  id: 1,
  publicId: 'abcdefghjk',
  nickname: 'Staff',
  avatarUrl: null,
  birthDate: '1990-01-01',
  role,
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
});

const complaint = (id: number, targetUser: ComplaintDto['targetUser']): ComplaintDto => ({
  id,
  reporter: null,
  targetUser,
  targetGame: null,
  reason: 'scam',
  message: 'Текст',
  status: 'new',
  resolvedBy: null,
  resolvedAt: null,
  sanctionId: null,
  createdAt: '2026-11-24T10:00:00.000Z',
});

const items = [
  complaint(1, { publicId: 'user000001', nickname: 'Ярема', role: 'user' }),
  complaint(2, { publicId: 'mod0000001', nickname: 'Модер', role: 'moderator' }),
  complaint(3, { publicId: 'gone000001', nickname: null, role: 'user' }),
];

describe('AdminComplaints', () => {
  let fixture: ComponentFixture<AdminComplaints>;
  let http: HttpTestingController;
  let el: HTMLElement;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function open(role: UserRole) {
    await TestBed.configureTestingModule({
      imports: [AdminComplaints],
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
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AdminComplaints);
    el = fixture.nativeElement as HTMLElement;
    await settle();
    http.expectOne((r) => r.url === '/api/admin/complaints').flush({ items, nextCursor: null });
    await settle();
  }

  afterEach(() => http.verify());

  const actionFor = (id: number) => el.querySelector(`[data-complaint="${id}"] button.take-action`);

  it('a moderator may act on users only; not on staff or deleted accounts (ban is admin+)', async () => {
    await open('moderator');
    expect(actionFor(1)).not.toBeNull();
    expect(actionFor(2)).toBeNull();
    expect(actionFor(3)).toBeNull();
    // Відхилити можна завжди.
    expect(el.querySelector('[data-complaint="2"] button.dismiss')).not.toBeNull();
  });

  it('an admin may act on moderators and ban deleted accounts', async () => {
    await open('admin');
    expect(actionFor(1)).not.toBeNull();
    expect(actionFor(2)).not.toBeNull();
    expect(actionFor(3)).not.toBeNull();
  });
});
