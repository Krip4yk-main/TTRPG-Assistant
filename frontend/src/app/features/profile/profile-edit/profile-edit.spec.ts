import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { CatalogDto, MeDto, ProfileDto, ProfileInput } from '@nri/shared';
import { ProfileEdit } from './profile-edit';
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
  defaultView: 'player',
  avatarSource: 'auto',
  customAvatarUrl: null,
  avatarOptions: [],
  identities: [],
} satisfies MeDto;

const catalog: CatalogDto = {
  systems: [{ id: 1, slug: 'dnd5e', name: 'D&D 5e', defaultGenreId: 1 }],
  genres: [{ id: 1, slug: 'fantasy' }],
  contentWarnings: [],
};

const profile: ProfileDto = {
  bio: 'Люблю хоррор',
  city: 'Київ',
  favoriteSystemIds: [1],
  preferredFormats: ['online'],
  experience: 'veteran',
  privacy: {
    bio: false,
    city: true,
    favoriteSystems: true,
    preferredFormats: true,
    experience: true,
  },
};

describe('ProfileEdit', () => {
  let fixture: ComponentFixture<ProfileEdit>;
  let http: HttpTestingController;

  const el = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const toggle = (key: string) =>
    el().querySelector<HTMLButtonElement>(`[data-privacy="${key}"] button[role=switch]`)!;

  beforeEach(async () => {
    TestBed.configureTestingModule({
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
    });
    TestBed.inject(AuthStore).setMe(me);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ProfileEdit);
    await settle();
    http.expectOne('/api/catalog').flush(catalog);
    http.expectOne((r) => r.method === 'GET' && r.url === '/api/me/profile').flush(profile);
    await settle();
  });

  afterEach(() => http.verify());

  it('has a visibility switch next to every field, reflecting privacy', () => {
    for (const k of ['bio', 'city', 'favoriteSystems', 'preferredFormats', 'experience']) {
      expect(toggle(k)).toBeTruthy();
    }
    expect(toggle('bio').getAttribute('aria-checked')).toBe('false');
    expect(toggle('city').getAttribute('aria-checked')).toBe('true');
    expect(el().querySelector<HTMLTextAreaElement>('textarea[name=bio]')!.value).toBe(
      'Люблю хоррор',
    );
  });

  it('saves fields and per-field visibility with PATCH', async () => {
    toggle('city').click();
    await settle();
    const bio = el().querySelector<HTMLTextAreaElement>('textarea[name=bio]')!;
    bio.value = 'Люблю хоррор і детективи';
    bio.dispatchEvent(new Event('input'));
    await settle();

    el().querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    await settle();
    const req = http.expectOne((r) => r.method === 'PATCH' && r.url === '/api/me/profile');
    const body = req.request.body as ProfileInput;
    expect(body.bio).toBe('Люблю хоррор і детективи');
    expect(body.privacy).toEqual({ ...profile.privacy, city: false });
    req.flush({ ...profile, bio: body.bio!, privacy: { ...profile.privacy, city: false } });
    await settle();
    expect(el().textContent).toContain('profileEdit.saved');
  });

  it('VALIDATION UNKNOWN_SYSTEM is shown next to the favorite systems field', async () => {
    el().querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    await settle();
    http
      .expectOne((r) => r.method === 'PATCH' && r.url === '/api/me/profile')
      .flush(
        { error: { code: 'VALIDATION', details: { reason: 'UNKNOWN_SYSTEM' } } },
        { status: 400, statusText: 'Bad Request' },
      );
    await settle();
    const err = el().querySelector('mat-error.unknown-system');
    expect(err).not.toBeNull();
    expect(err!.textContent).toContain('games.form.errors.UNKNOWN_SYSTEM');
    expect(
      err!.closest('.field')!.querySelector('[data-privacy="favoriteSystems"]'),
    ).not.toBeNull();
    expect(el().textContent).not.toContain('profileEdit.saveError');
  });
});
