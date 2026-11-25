import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { of, Subject } from 'rxjs';
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
  uiTheme: 'quest-board',
  availableThemes: ['quest-board'],
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
    gmRating: null,
    closedByAdmin: false,
    ...overrides,
  };
}

const open = vi.fn();

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
        { provide: MatDialog, useValue: { open } },
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

  beforeEach(() => {
    open.mockReset();
    localStorage.clear();
  });
  afterEach(() => {
    http.verify();
    localStorage.clear();
    vi.restoreAllMocks();
  });

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

  describe('creation blocked by «dead» games', () => {
    const dead = (id: number, title: string, status: 'recruiting' | 'started') => ({
      id,
      title,
      status,
      state: 'dead' as const,
      suspicious: false,
      lastActivityAt: '2026-07-01T10:00:00.000Z',
      deadAt: '2026-10-01T04:00:00.000Z',
      suspiciousAt: null,
    });
    const notice = () => el.querySelector<HTMLElement>('nri-dead-games-notice');
    const button = (id: number, action: string) =>
      notice()!.querySelector<HTMLButtonElement>(
        `[data-game-id="${id}"] [data-action="${action}"]`,
      )!;

    async function blocked(): Promise<void> {
      await setup();
      await fillValid();
      await submit();
      http
        .expectOne('/api/games')
        .flush(
          { error: { code: 'GAME_CREATION_BLOCKED', details: { deadGameIds: [3, 4] } } },
          { status: 409, statusText: 'Conflict' },
        );
      await settle();
      http.expectOne('/api/me/dead-games').flush({
        items: [
          dead(3, 'Покинута кампанія', 'started'),
          dead(4, 'Забутий набір', 'recruiting'),
          // «Давно не проводилась» — не блокує, у поясненні її немає.
          { ...dead(9, 'Стара', 'recruiting'), state: 'stale' },
        ],
        deadGameIds: [3, 4],
      });
      await settle();
    }

    it('explains the block and lists the dead games with links and actions', async () => {
      await blocked();
      expect(notice()!.textContent).toContain('games.dead.blocked.title');
      expect(notice()!.querySelector('a[href="/games/3"]')!.textContent).toContain(
        'Покинута кампанія',
      );
      expect(notice()!.querySelector('a[href="/games/4"]')).not.toBeNull();
      expect(notice()!.querySelector('[data-game-id="9"]')).toBeNull();
      expect(el.querySelector('.form-actions + p.nri-alert, p.nri-alert[role="alert"]')).toBeNull();
    });

    it('«all ok» and «close» resolve the games; then the form may be saved again', async () => {
      await blocked();
      button(3, 'still-alive').click();
      await settle();
      http.expectOne('/api/games/3/still-alive').flush({ ...dead(3, 'x', 'started'), state: 'ok' });
      await settle();
      expect(notice()!.querySelector('[data-game-id="3"]')).toBeNull();

      // «Закрити» — лише після підтвердження (текст залежить від статусу).
      open.mockReturnValueOnce({ afterClosed: () => of(false) });
      button(4, 'close-dead').click();
      await settle();
      expect(open.mock.calls[0]![1].data.note).toBe('games.dead.closeConfirm.recruiting');
      http.expectNone('/api/games/4/close-dead');

      open.mockReturnValueOnce({ afterClosed: () => of(true) });
      button(4, 'close-dead').click();
      await settle();
      http.expectOne('/api/games/4/close-dead').flush({ id: 4, status: 'cancelled' });
      await settle();
      expect(notice()).toBeNull();
      expect(el.querySelector('.unblocked-notice')!.textContent).toContain(
        'games.dead.blocked.unblocked',
      );
      // Кнопки останньої гри зникли — фокус на підказці.
      await vi.waitFor(() =>
        expect(document.activeElement).toBe(el.querySelector('.unblocked-notice')),
      );

      await submit();
      http.expectOne('/api/games').flush(game());
      await settle();
      expect(el.querySelector('.unblocked-notice')).toBeNull();
    });

    it('a 409 on an action reloads the list', async () => {
      await blocked();
      button(3, 'still-alive').click();
      await settle();
      http
        .expectOne('/api/games/3/still-alive')
        .flush({ error: { code: 'GAME_INVALID_TRANSITION' } }, { status: 409, statusText: 'C' });
      await settle();
      http.expectOne('/api/me/dead-games').flush({ items: [], deadGameIds: [] });
      await settle();
      expect(notice()).toBeNull();
      expect(el.querySelector('.unblocked-notice')).not.toBeNull();
    });
  });

  it('editing a recruiting game: system and kind are disabled with a hint', async () => {
    await setup(5, game({ status: 'recruiting' }));
    expect(selectOf('system').disabled).toBe(true);
    expect(el.textContent).toContain('games.form.lockedHint');
    expect(q<HTMLInputElement>('input[formcontrolname="title"]').disabled).toBe(false);
  });

  it('recruiting game: the schedule rule stays editable', async () => {
    await setup(5, game({ status: 'recruiting' }));
    expect(q<HTMLInputElement>('input[formcontrolname="startDate"]').disabled).toBe(false);
    expect(selectOf('durationMinutes').disabled).toBe(false);
    expect(el.querySelector('.schedule-locked')).toBeNull();
  });

  it('started game: the schedule rule is read-only with a hint; PATCH omits it', async () => {
    await setup(5, game({ status: 'started' }));
    expect(q<HTMLInputElement>('input[formcontrolname="startDate"]').disabled).toBe(true);
    expect(q<HTMLInputElement>('input[formcontrolname="startTime"]').disabled).toBe(true);
    expect(selectOf('durationMinutes').disabled).toBe(true);
    expect(selectOf('recurrence').disabled).toBe(true);
    const hint = q<HTMLElement>('.schedule-locked');
    expect(hint.textContent).toContain('games.form.scheduleLocked.');
    expect(hint.querySelector('a')!.getAttribute('href')).toBe('/games/5');
    expect(q<HTMLInputElement>('input[formcontrolname="title"]').disabled).toBe(false);
    await type('input[formcontrolname="title"]', 'Нова назва');
    await submit();
    const req = http.expectOne('/api/games/5');
    expect(req.request.body).toMatchObject({ title: 'Нова назва' });
    for (const field of ['startsAt', 'durationMinutes', 'recurrence', 'weekdays']) {
      expect(req.request.body).not.toHaveProperty(field);
    }
    req.flush(game({ status: 'started', title: 'Нова назва' }));
    await settle();
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

  describe('autosave', () => {
    const NEW_KEY = 'nri.gameDraft.1.new';
    const debounce = () => new Promise((r) => setTimeout(r, 600));
    const stored = (key: string) => {
      const raw = localStorage.getItem(key);
      return raw === null ? null : (JSON.parse(raw) as { values: Record<string, unknown> });
    };
    const seedDraft = (
      key: string,
      values: Record<string, unknown>,
      extra: { savedAt?: number; updatedAt?: string | null } = {},
    ) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          v: 1,
          savedAt: extra.savedAt ?? Date.now(),
          updatedAt: extra.updatedAt === undefined ? null : extra.updatedAt,
          values,
        }),
      );
    const titleInput = () => q<HTMLInputElement>('input[formcontrolname="title"]');
    const discardButton = () => el.querySelector<HTMLButtonElement>('button.discard');

    it('persists entered values per user and game after a debounce', async () => {
      await setup();
      await type('input[formcontrolname="title"]', 'Чернетка');
      await choose('system', 'Cyberpunk RED');
      expect(localStorage.getItem(NEW_KEY)).toBeNull();
      await debounce();
      expect(stored(NEW_KEY)!.values).toMatchObject({ title: 'Чернетка', system: 7, genreId: 4 });
    });

    it('restores a new game draft on reload and shows a notice', async () => {
      seedDraft(NEW_KEY, {
        title: 'Збережена назва',
        startDate: '2027-03-02',
        startTime: '19:00',
        channelLinks: [{ label: 'Discord', url: 'https://discord.gg/x' }],
        applicationQuestions: ['Чому ви?'],
      });
      await setup();
      expect(titleInput().value).toBe('Збережена назва');
      expect(q<HTMLInputElement>('input[formcontrolname="startTime"]').value).toBe('19:00');
      expect(q<HTMLInputElement>('input[formcontrolname="startDate"]').value).toBe('02.03.2027');
      expect(q<HTMLInputElement>('input[formcontrolname="url"]').value).toBe(
        'https://discord.gg/x',
      );
      expect(q<HTMLElement>('.restored-notice').textContent).toContain('games.form.restored');
    });

    it('restores stored values on top of an existing game', async () => {
      seedDraft(
        'nri.gameDraft.1.5',
        { title: 'Незбережена назва' },
        { updatedAt: '2026-11-01T10:00:00.000Z' },
      );
      await setup(5, game({ status: 'draft' }));
      expect(titleInput().value).toBe('Незбережена назва');
      expect(el.querySelector('.restored-notice')).not.toBeNull();
    });

    it('a stored copy of another user is not used', async () => {
      seedDraft('nri.gameDraft.2.new', { title: 'Чуже' });
      await setup();
      expect(titleInput().value).toBe('');
      expect(el.querySelector('.restored-notice')).toBeNull();
    });

    it('never restores or persists for finished/cancelled games', async () => {
      seedDraft(
        'nri.gameDraft.1.5',
        { title: 'Незбережена назва' },
        { updatedAt: '2026-11-01T10:00:00.000Z' },
      );
      await setup(5, game({ status: 'finished' }));
      expect(titleInput().value).toBe('Тіні Найт-Сіті');
      expect(el.querySelector('.restored-notice')).toBeNull();
      expect(discardButton()).toBeNull();
      await debounce();
      expect(localStorage.getItem('nri.gameDraft.1.5')).toBeNull();
    });

    it('a successful save clears the stored copy', async () => {
      await setup();
      await fillValid();
      await debounce();
      expect(localStorage.getItem(NEW_KEY)).not.toBeNull();
      await submit();
      http.expectOne('/api/games').flush(game());
      await settle();
      await debounce();
      expect(localStorage.getItem(NEW_KEY)).toBeNull();
      expect(localStorage.getItem('nri.gameDraft.1.5')).toBeNull();
    });

    it('a failed save keeps the stored copy', async () => {
      await setup(5, game({ status: 'draft' }));
      await type('input[formcontrolname="title"]', 'Нова назва');
      await submit();
      http
        .expectOne('/api/games/5')
        .flush({ error: { code: 'INTERNAL' } }, { status: 500, statusText: 'Error' });
      await settle();
      await debounce();
      expect(stored('nri.gameDraft.1.5')!.values).toMatchObject({ title: 'Нова назва' });
    });

    it('discard asks for confirmation; a new game resets to defaults', async () => {
      await setup();
      await type('input[formcontrolname="title"]', 'Чернетка');
      await debounce();
      open.mockReturnValueOnce({ afterClosed: () => of(false) });
      discardButton()!.click();
      await settle();
      expect(open).toHaveBeenCalledTimes(1);
      expect(titleInput().value).toBe('Чернетка');
      expect(localStorage.getItem(NEW_KEY)).not.toBeNull();

      open.mockReturnValueOnce({ afterClosed: () => of(true) });
      discardButton()!.click();
      await settle();
      expect(titleInput().value).toBe('');
      expect(localStorage.getItem(NEW_KEY)).toBeNull();
      await debounce();
      expect(localStorage.getItem(NEW_KEY)).toBeNull();
    });

    it('discard on an existing game reloads the server values', async () => {
      seedDraft(
        'nri.gameDraft.1.5',
        { title: 'Незбережена назва' },
        { updatedAt: '2026-11-01T10:00:00.000Z' },
      );
      await setup(5, game({ status: 'draft' }));
      open.mockReturnValueOnce({ afterClosed: () => of(true) });
      q<HTMLButtonElement>('.restored-notice button').click();
      await settle();
      http.expectOne('/api/games/5').flush(game({ status: 'draft' }));
      await settle();
      expect(titleInput().value).toBe('Тіні Найт-Сіті');
      expect(el.querySelector('.restored-notice')).toBeNull();
      expect(localStorage.getItem('nri.gameDraft.1.5')).toBeNull();
    });

    it('stores the server updatedAt with the copy', async () => {
      await setup(5, game({ status: 'draft' }));
      await type('input[formcontrolname="title"]', 'Нова назва');
      await debounce();
      const raw = JSON.parse(localStorage.getItem('nri.gameDraft.1.5')!) as {
        updatedAt: string;
        savedAt: number;
      };
      expect(raw.updatedAt).toBe('2026-11-01T10:00:00.000Z');
      expect(raw.savedAt).toEqual(expect.any(Number));
    });

    it('a copy older than the server game is dropped with a notice', async () => {
      seedDraft(
        'nri.gameDraft.1.5',
        { title: 'Застаріла назва' },
        { updatedAt: '2026-11-01T10:00:00.000Z' },
      );
      await setup(5, game({ status: 'draft', updatedAt: '2026-11-02T10:00:00.000Z' }));
      expect(titleInput().value).toBe('Тіні Найт-Сіті');
      expect(el.querySelector('.restored-notice')).toBeNull();
      expect(q<HTMLElement>('.stale-notice').textContent).toContain('games.form.staleDraft');
      expect(localStorage.getItem('nri.gameDraft.1.5')).toBeNull();
    });

    it('a copy older than 7 days is dropped', async () => {
      seedDraft(NEW_KEY, { title: 'Давня назва' }, { savedAt: Date.now() - 8 * 86_400_000 });
      await setup();
      expect(titleInput().value).toBe('');
      expect(el.querySelector('.restored-notice')).toBeNull();
      expect(localStorage.getItem(NEW_KEY)).toBeNull();
    });

    it('storage failures never break the form', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('denied');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota');
      });
      await setup();
      await type('input[formcontrolname="title"]', 'Назва');
      await debounce();
      expect(titleInput().value).toBe('Назва');
    });
  });
});
