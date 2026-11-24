import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { CatalogDto, GameDto, MeDto } from '@nri/shared';
import { GameForm } from './game-form';
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

const catalog: CatalogDto = {
  systems: [
    { id: 1, slug: 'dnd5e', name: 'D&D 5e', defaultGenreId: 1 },
    { id: 7, slug: 'cyberpunk-red', name: 'Cyberpunk RED', defaultGenreId: 4 },
  ],
  genres: [
    { id: 1, slug: 'fantasy' },
    { id: 3, slug: 'horror' },
    { id: 4, slug: 'cyberpunk' },
  ],
  contentWarnings: [
    { id: 1, slug: 'violence' },
    { id: 2, slug: 'gore' },
  ],
};

function game(overrides: Partial<GameDto> = {}): GameDto {
  return {
    id: 5,
    title: 'Тіні Найт-Сіті',
    description: '',
    system: { id: 7, name: 'Cyberpunk RED' },
    systemOther: null,
    genreId: 4,
    format: 'online',
    city: null,
    address: null,
    platform: 'Foundry',
    kind: 'campaign',
    startsAt: '2027-03-02T17:00:00.000Z',
    durationMinutes: 180,
    recurrence: 'none',
    weekdays: [],
    minPlayers: 3,
    maxPlayers: 5,
    priceUah: null,
    ageRating: 'none',
    experience: 'any',
    language: 'uk',
    requirements: null,
    coverUrl: null,
    channelLinks: [],
    applicationQuestions: [],
    customWarnings: [],
    contentWarningIds: [],
    showWhenFull: false,
    gm: { publicId: 'abcdefghjk', nickname: 'Gandalf', avatarUrl: null },
    timezone: 'Europe/Kyiv',
    status: 'draft',
    nextSessionAt: '2027-03-02T17:00:00.000Z',
    freeSlots: 5,
    publishedAt: null,
    startedAt: null,
    finishedAt: null,
    cancelledAt: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('GameForm', () => {
  let fixture: ComponentFixture<GameForm>;
  let http: HttpTestingController;
  let el: HTMLElement;

  const q = <T extends Element>(sel: string) => el.querySelector<T>(sel)!;
  const selectOf = (name: string) => q<HTMLSelectElement>(`select[formcontrolname="${name}"]`);
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const choose = async (name: string, text: string) => {
    const s = selectOf(name);
    const i = Array.from(s.options).findIndex((o) => o.textContent!.includes(text));
    expect(i).toBeGreaterThanOrEqual(0);
    s.selectedIndex = i;
    s.dispatchEvent(new Event('change'));
    await settle();
  };
  const type = async (selector: string, value: string) => {
    const input = q<HTMLInputElement>(selector);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    await settle();
  };
  const selectedText = (name: string) => selectOf(name).selectedOptions[0]?.textContent ?? '';
  const publishButton = () => q<HTMLButtonElement>('button.publish');
  const submit = async () => {
    q<HTMLFormElement>('form.game-form').dispatchEvent(new Event('submit'));
    await settle();
  };

  async function setup(id?: number, dto?: GameDto, user: MeDto = me): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [GameForm],
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
    TestBed.inject(AuthStore).setMe(user);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GameForm);
    if (id !== undefined) fixture.componentRef.setInput('id', String(id));
    el = fixture.nativeElement as HTMLElement;
    await settle();
    http.expectOne('/api/catalog').flush(catalog);
    if (id !== undefined) http.expectOne(`/api/games/${id}`).flush(dto ?? game({ id }));
    await settle();
  }

  async function fillValid(): Promise<void> {
    await type('input[formcontrolname="title"]', 'Тіні Найт-Сіті');
    await choose('system', 'Cyberpunk RED');
    await type('input[formcontrolname="startDate"]', '02.03.2027');
    await type('input[formcontrolname="startTime"]', '19:00');
  }

  afterEach(() => http.verify());

  it('choosing cyberpunk-red sets the default genre cyberpunk', async () => {
    await setup();
    await choose('system', 'Cyberpunk RED');
    expect(selectedText('genreId')).toContain('genres.cyberpunk');
  });

  it('does not overwrite a genre the user picked manually', async () => {
    await setup();
    await choose('genreId', 'genres.horror');
    await choose('system', 'Cyberpunk RED');
    expect(selectedText('genreId')).toContain('genres.horror');
  });

  it('"Other" system reveals the system name field', async () => {
    await setup();
    expect(el.querySelector('input[formcontrolname="systemOther"]')).toBeNull();
    await choose('system', 'games.form.systemOther');
    expect(el.querySelector('input[formcontrolname="systemOther"]')).not.toBeNull();
  });

  it('offline without a city: publish is disabled and the error is next to the city field', async () => {
    await setup();
    await fillValid();
    expect(publishButton().disabled).toBe(false);

    q<HTMLInputElement>('mat-radio-button.format-offline input').click();
    await settle();
    expect(publishButton().disabled).toBe(true);
    // Пояснення, що адресу бачать лише затверджені гравці.
    expect(el.textContent).toContain('games.form.addressHint');

    await submit();
    http.expectNone('/api/games');
    const cityField = q<HTMLInputElement>('input[formcontrolname="city"]').closest('.field')!;
    expect(cityField.textContent).toContain('games.form.errors.cityRequired');
  });

  it('valid new game: "save draft" POSTs the game with a UTC whole-minute startsAt', async () => {
    await setup();
    await fillValid();
    await submit();
    const req = http.expectOne('/api/games');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toMatchObject({
      title: 'Тіні Найт-Сіті',
      systemId: 7,
      systemOther: null,
      genreId: 4,
      // 19:00 у Києві 2 березня 2027 (UTC+2).
      startsAt: '2027-03-02T17:00:00.000Z',
    });
    req.flush(game());
    await settle();
  });

  it('editing a recruiting game: system and kind are disabled with a hint', async () => {
    await setup(5, game({ status: 'recruiting' }));
    expect(selectOf('system').disabled).toBe(true);
    expect(el.textContent).toContain('games.form.lockedHint');
    expect(q<HTMLInputElement>('input[formcontrolname="title"]').disabled).toBe(false);
  });

  it('409 GAME_FIELD_LOCKED shows the translation next to the field', async () => {
    await setup(5, game({ status: 'draft' }));
    await submit();
    const req = http.expectOne('/api/games/5');
    expect(req.request.method).toBe('PATCH');
    req.flush(
      { error: { code: 'GAME_FIELD_LOCKED', details: { field: 'systemId' } } },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();
    const systemField = selectOf('system').closest('.field')!;
    expect(systemField.textContent).toContain('errors.GAME_FIELD_LOCKED');
  });

  it('recruiting game: locked fields are omitted from the PATCH body', async () => {
    await setup(5, game({ status: 'recruiting' }));
    await type('input[formcontrolname="title"]', 'Нова назва');
    await submit();
    const req = http.expectOne('/api/games/5');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toMatchObject({ title: 'Нова назва', genreId: 4 });
    for (const field of ['systemId', 'systemOther', 'kind']) {
      expect(req.request.body).not.toHaveProperty(field);
    }
    req.flush(game({ status: 'recruiting', title: 'Нова назва' }));
    await settle();
  });

  it('a server field error clears once the user edits that field', async () => {
    await setup(5, game({ status: 'draft' }));
    await submit();
    http
      .expectOne('/api/games/5')
      .flush({ error: { code: 'GAME_IN_PAST' } }, { status: 422, statusText: 'Unprocessable' });
    await settle();
    const dateField = () =>
      q<HTMLInputElement>('input[formcontrolname="startDate"]').closest('.field')!;
    expect(dateField().textContent).toContain('errors.GAME_IN_PAST');
    // Редагування іншого поля помилку не прибирає.
    await type('input[formcontrolname="title"]', 'Інша назва');
    expect(dateField().textContent).toContain('errors.GAME_IN_PAST');
    await type('input[formcontrolname="startDate"]', '03.03.2027');
    expect(dateField().textContent).not.toContain('errors.GAME_IN_PAST');
  });

  it('min > max players: error next to the max field, publish hint names the section', async () => {
    await setup();
    await fillValid();
    await type('input[formcontrolname="minPlayers"]', '6');
    const maxField = q<HTMLInputElement>('input[formcontrolname="maxPlayers"]').closest('.field')!;
    expect(maxField.textContent).toContain('games.form.errors.players');
    expect(publishButton().disabled).toBe(true);
    const hint = q<HTMLElement>('#publish-hint');
    expect(hint.textContent).toContain('games.form.publishHintSections');
    expect(
      Array.from(hint.querySelectorAll('.invalid-section')).map((s) => s.textContent!.trim()),
    ).toEqual(['games.form.sections.players']);
  });

  it('reloads when the route id changes (component reuse)', async () => {
    await setup(5, game({ status: 'recruiting' }));
    fixture.componentRef.setInput('id', '6');
    await settle();
    http.expectOne('/api/games/6').flush(game({ id: 6, title: 'Друга гра', status: 'draft' }));
    await settle();
    expect(q<HTMLInputElement>('input[formcontrolname="title"]').value).toBe('Друга гра');
    // Блокування попередньої (recruiting) гри не лишилося.
    expect(selectOf('system').disabled).toBe(false);
  });

  it('a user under 18 cannot pick 18+/21+ age ratings', async () => {
    const today = new Date();
    const teen = { ...me, birthDate: `${today.getFullYear() - 16}-01-01` };
    await setup(undefined, undefined, teen);
    const options = Array.from(selectOf('ageRating').options);
    const disabled = options.filter((o) => o.disabled).map((o) => o.textContent!.trim());
    expect(disabled).toEqual(['games.ageRating.18+', 'games.ageRating.21+']);
  });
});
