import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { MeDto } from '@nri/shared';
import { AvatarPicker } from './avatar-picker';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';

const me = {
  id: 1,
  publicId: 'abcdefghjk',
  nickname: 'Frodo',
  avatarUrl: 'https://g.example/a.png',
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
  avatarOptions: [
    { source: 'google', previewUrl: 'https://g.example/a.png' },
    { source: 'telegram', previewUrl: 'https://t.example/b.png' },
  ],
  identities: [],
} satisfies MeDto;

describe('AvatarPicker', () => {
  let fixture: ComponentFixture<AvatarPicker>;
  let http: HttpTestingController;
  let auth: AuthStore;

  const el = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const radio = (v: string) => el().querySelector<HTMLInputElement>(`input[value=${v}]`)!;
  const choose = async (v: string) => {
    radio(v).click();
    await settle();
  };
  const save = async () => {
    el().querySelector<HTMLButtonElement>('.actions button')!.click();
    await settle();
  };
  const put = () => http.expectOne((r) => r.method === 'PUT' && r.url === '/api/me/avatar');

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
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
    });
    auth = TestBed.inject(AuthStore);
    auth.setMe(me);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AvatarPicker);
    await settle();
  });

  afterEach(() => http.verify());

  it('shows only available providers plus auto, custom and none, in a radio group', () => {
    const values = [...el().querySelectorAll<HTMLInputElement>('input[type=radio]')].map(
      (i) => i.value,
    );
    expect(values).toEqual(['auto', 'google', 'telegram', 'custom', 'none']);
    expect(el().querySelector('[role=radiogroup]')).toBeTruthy();
    expect(radio('auto').checked).toBe(true);
    expect(el().querySelectorAll('img.preview').length).toBe(3);
  });

  it('falls back to a placeholder when a preview image fails to load', async () => {
    const img = el().querySelector<HTMLImageElement>('img.preview[src="https://t.example/b.png"]')!;
    img.dispatchEvent(new Event('error'));
    await settle();
    expect(el().querySelector('img.preview[src="https://t.example/b.png"]')).toBeNull();
    expect(el().querySelectorAll('.preview.placeholder').length).toBeGreaterThan(0);
  });

  it('saves a provider choice and updates the current user', async () => {
    await choose('telegram');
    await save();
    const req = put();
    expect(req.request.body).toEqual({ source: 'telegram' });
    req.flush({ ...me, avatarSource: 'telegram', avatarUrl: 'https://t.example/b.png' });
    await settle();
    expect(auth.me()?.avatarUrl).toBe('https://t.example/b.png');
    expect(radio('telegram').checked).toBe(true);
    expect(el().textContent).toContain('avatarPicker.saved');
  });

  it('sends the custom url only for the custom source and rejects a non-https one locally', async () => {
    await choose('custom');
    const input = el().querySelector<HTMLInputElement>('input[name=customAvatarUrl]')!;
    input.value = 'http://x.example/a.png';
    input.dispatchEvent(new Event('input'));
    await save();
    http.expectNone('/api/me/avatar');
    expect(el().textContent).toContain('avatarPicker.errors.urlInvalid');

    input.value = 'https://x.example/a.png';
    input.dispatchEvent(new Event('input'));
    await save();
    const req = put();
    expect(req.request.body).toEqual({ source: 'custom', customUrl: 'https://x.example/a.png' });
    req.flush({
      ...me,
      avatarSource: 'custom',
      customAvatarUrl: 'https://x.example/a.png',
      avatarUrl: 'https://x.example/a.png',
    });
    await settle();
    expect(auth.me()?.avatarSource).toBe('custom');
  });

  it.each(['not_image', 'too_large'])(
    'IMAGE_URL_INVALID %s shows the reason next to the field',
    async (reason) => {
      await choose('custom');
      const input = el().querySelector<HTMLInputElement>('input[name=customAvatarUrl]')!;
      input.value = 'https://x.example/a';
      input.dispatchEvent(new Event('input'));
      await save();
      put().flush(
        { error: { code: 'IMAGE_URL_INVALID', details: { field: 'customUrl', reason } } },
        { status: 422, statusText: 'Unprocessable' },
      );
      await settle();
      expect(el().querySelector('.url-error')!.textContent).toContain(`errors.imageUrl.${reason}`);
      expect(auth.me()?.avatarSource).toBe('auto');
    },
  );

  it.each(['AVATAR_SOURCE_UNAVAILABLE', 'RATE_LIMITED'])(
    '%s shows an error message',
    async (code) => {
      await choose('google');
      await save();
      put().flush(
        { error: { code } },
        { status: code === 'RATE_LIMITED' ? 429 : 422, statusText: 'x' },
      );
      await settle();
      expect(el().querySelector('[role=alert]')!.textContent).toContain(`errors.${code}`);
    },
  );

  it('can switch to no avatar', async () => {
    await choose('none');
    await save();
    const req = put();
    expect(req.request.body).toEqual({ source: 'none' });
    req.flush({ ...me, avatarSource: 'none', avatarUrl: null });
    await settle();
    expect(auth.me()?.avatarUrl).toBeNull();
  });
});
