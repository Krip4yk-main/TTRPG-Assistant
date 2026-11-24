import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { MeDto } from '@nri/shared';
import { AccountSettings } from './account-settings';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';

const me: MeDto = {
  id: 1,
  publicId: 'abcdefghjk',
  nickname: 'Gandalf',
  avatarUrl: null,
  birthDate: '1990-01-01',
  role: 'user',
  status: 'active',
  timezone: 'Europe/Kyiv',
  locale: 'uk',
  identities: [{ provider: 'dev', displayName: 'G' }],
};

describe('AccountSettings nickname', () => {
  let fixture: ComponentFixture<AccountSettings>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let auth: AuthStore;

  const input = () => el.querySelector<HTMLInputElement>('input[name="nickname"]')!;
  const form = () => el.querySelector<HTMLFormElement>('form.nickname')!;
  const type = async (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AccountSettings],
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
            sessionLost$: new Subject(),
          },
        },
      ],
    }).compileComponents();
    auth = TestBed.inject(AuthStore);
    auth.setMe(me);
    fixture = TestBed.createComponent(AccountSettings);
    http = TestBed.inject(HttpTestingController);
    el = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  });

  afterEach(() => http.verify());

  it('prefills the current nickname; saving PATCHes and updates AuthStore.me()', async () => {
    expect(input().value).toBe('Gandalf');
    await type('Saruman');
    form().dispatchEvent(new Event('submit'));
    const req = http.expectOne('/api/me/nickname');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ nickname: 'Saruman' });
    req.flush({ ...me, nickname: 'Saruman' });
    await fixture.whenStable();
    expect(auth.me()?.nickname).toBe('Saruman');
    expect(auth.me()?.publicId).toBe('abcdefghjk');
  });

  it('invalid nickname is not sent and shows a format error', async () => {
    await type('a!');
    form().dispatchEvent(new Event('submit'));
    http.expectNone('/api/me/nickname');
    expect(el.textContent).toContain('profile.errors.NICKNAME_FORMAT');
  });

  it('409 NICKNAME_TAKEN shows the error next to the field', async () => {
    await type('Saruman');
    form().dispatchEvent(new Event('submit'));
    http
      .expectOne('/api/me/nickname')
      .flush({ error: { code: 'NICKNAME_TAKEN' } }, { status: 409, statusText: 'Conflict' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).toContain('profile.errors.NICKNAME_TAKEN');
    expect(auth.me()?.nickname).toBe('Gandalf');
  });
});
