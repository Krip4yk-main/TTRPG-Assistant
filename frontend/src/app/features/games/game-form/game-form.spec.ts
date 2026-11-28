import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { of, Subject } from 'rxjs';
import type { CatalogDto, GameDto, MeDto } from '@nri/shared';
import { GameForm } from './game-form';
import uk from '../../../../assets/i18n/uk.json';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';
import {
  isOptionDisabled,
  isSelectDisabled,
  openOptions,
  optionText,
  pickIndex,
  pickText,
  selectedText as matSelectedText,
} from '../../../../testing/mat-select';

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
  uiPrefs: { tearAnimation: true, sendAnimation: true },
  myLimits: [],
  defaultView: 'player',
  avatarSource: 'auto',
  customAvatarUrl: null,
  avatarOptions: [],
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
    startWindowMinutes: null,
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
    safetyTools: [],
    lines: { warningIds: [], custom: [] },
    veils: { warningIds: [], custom: [] },
    showWhenFull: false,
    gm: { publicId: 'abcdefghjk', nickname: 'Gandalf', avatarUrl: null },
    timezone: 'Europe/Kyiv',
    status: 'draft',
    nextSessionAt: '2027-03-02T17:00:00.000Z',
    nextSessionWindowMinutes: null,
    freeSlots: 5,
    publishedAt: null,
    startedAt: null,
    finishedAt: null,
    cancelledAt: null,
    pausedAt: null,
    pauseReason: null,
    pauseNote: null,
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
  const selectOf = (name: string) => q<HTMLElement>(`mat-select[formcontrolname="${name}"]`);
  const winSelect = (cls: 'window-from' | 'window-to') => q<HTMLElement>(`mat-select.${cls}`);
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const choose = async (name: string, text: string) => {
    await pickText(selectOf(name), text, settle);
  };
  const type = async (selector: string, value: string) => {
    const input = q<HTMLInputElement>(selector);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    await settle();
  };
  const selectedText = (name: string) => matSelectedText(selectOf(name));
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
    await type('nri-start-time-field input.time', '19:00');
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

  it('a new draft may be saved without a start date (startsAt: null)', async () => {
    await setup();
    await type('input[formcontrolname="title"]', 'Тіні Найт-Сіті');
    await choose('system', 'Cyberpunk RED');
    expect(el.textContent).toContain('games.form.startDateDraftHint');
    await submit();
    const req = http.expectOne('/api/games');
    expect(req.request.body).toMatchObject({ startsAt: null });
    req.flush(game({ startsAt: null, nextSessionAt: null }));
    await settle();
  });

  it('a draft date can be cleared; publishing without a date shows GAME_START_REQUIRED and sends nothing', async () => {
    await setup(5, game({ status: 'draft' }));
    const clear = q<HTMLButtonElement>('button.clear-start');
    clear.click();
    await settle();
    expect(q<HTMLInputElement>('input[formcontrolname="startDate"]').value).toBe('');
    expect(el.querySelector('button.clear-start')).toBeNull();
    expect(publishButton().disabled).toBe(false);
    publishButton().click();
    await settle();
    http.expectNone('/api/games/5');
    const dateField = q<HTMLInputElement>('input[formcontrolname="startDate"]').closest('.field')!;
    expect(dateField.textContent).toContain('errors.GAME_START_REQUIRED');
    expect(String(uk.errors.GAME_START_REQUIRED)).toContain('дату');
    // Зберегти чернетку без дати — можна.
    await submit();
    const req = http.expectOne('/api/games/5');
    expect(req.request.body).toMatchObject({ startsAt: null });
    req.flush(game({ startsAt: null, nextSessionAt: null }));
    await settle();
  });

  it('a dateless draft opens with empty date and time fields', async () => {
    await setup(5, game({ startsAt: null, nextSessionAt: null }));
    expect(q<HTMLInputElement>('input[formcontrolname="startDate"]').value).toBe('');
    expect(q<HTMLInputElement>('nri-start-time-field input.time').value).toBe('');
    expect(el.querySelector('button.clear-start')).toBeNull();
  });

  it('a published game: the date cannot be cleared (no clear button, empty date is required)', async () => {
    await setup(5, game({ status: 'recruiting' }));
    expect(el.querySelector('button.clear-start')).toBeNull();
    await type('input[formcontrolname="startDate"]', '');
    await submit();
    http.expectNone('/api/games/5');
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
    expect(isSelectDisabled(selectOf('system'))).toBe(true);
    expect(el.textContent).toContain('games.form.lockedHint');
    expect(q<HTMLInputElement>('input[formcontrolname="title"]').disabled).toBe(false);
  });

  it('recruiting game: the schedule rule stays editable', async () => {
    await setup(5, game({ status: 'recruiting' }));
    expect(q<HTMLInputElement>('input[formcontrolname="startDate"]').disabled).toBe(false);
    expect(isSelectDisabled(selectOf('durationMinutes'))).toBe(false);
    expect(el.querySelector('.schedule-locked')).toBeNull();
  });

  it('started game: the schedule rule is read-only with a hint; PATCH omits it', async () => {
    await setup(5, game({ status: 'started' }));
    expect(q<HTMLInputElement>('input[formcontrolname="startDate"]').disabled).toBe(true);
    expect(q<HTMLInputElement>('nri-start-time-field input.time').disabled).toBe(true);
    expect(isSelectDisabled(selectOf('durationMinutes'))).toBe(true);
    expect(isSelectDisabled(selectOf('recurrence'))).toBe(true);
    const hint = q<HTMLElement>('.schedule-locked');
    expect(hint.textContent).toContain('games.form.scheduleLocked.');
    expect(hint.querySelector('a')!.getAttribute('href')).toBe('/games/5');
    expect(q<HTMLInputElement>('input[formcontrolname="title"]').disabled).toBe(false);
    await type('input[formcontrolname="title"]', 'Нова назва');
    await submit();
    const req = http.expectOne('/api/games/5');
    expect(req.request.body).toMatchObject({ title: 'Нова назва' });
    for (const field of [
      'startsAt',
      'startWindowMinutes',
      'durationMinutes',
      'recurrence',
      'weekdays',
    ]) {
      expect(req.request.body).not.toHaveProperty(field);
    }
    // Перемикач «Точний / Приблизно» теж вимкнено.
    expect(q<HTMLButtonElement>('.mode-approx button').disabled).toBe(true);
    req.flush(game({ status: 'started', title: 'Нова назва' }));
    await settle();
  });

  it('paused campaign: other fields editable, schedule disabled with the «changes on resume» hint', async () => {
    await setup(5, game({ status: 'paused', kind: 'campaign' }));
    expect(q<HTMLInputElement>('input[formcontrolname="startDate"]').disabled).toBe(true);
    expect(q<HTMLInputElement>('nri-start-time-field input.time').disabled).toBe(true);
    expect(isSelectDisabled(selectOf('durationMinutes'))).toBe(true);
    expect(isSelectDisabled(selectOf('recurrence'))).toBe(true);
    expect(isSelectDisabled(selectOf('system'))).toBe(true);
    const hint = q<HTMLElement>('.schedule-locked');
    expect(hint.textContent).toContain('games.form.scheduleLocked.paused');
    expect(hint.querySelector('a')!.getAttribute('href')).toBe('/games/5');
    expect(String(uk.games.form.scheduleLocked.paused)).toContain('при відновленні');
    expect(q<HTMLInputElement>('input[formcontrolname="title"]').disabled).toBe(false);
    await type('input[formcontrolname="title"]', 'Нова назва');
    await submit();
    const req = http.expectOne('/api/games/5');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toMatchObject({ title: 'Нова назва' });
    for (const field of ['startsAt', 'durationMinutes', 'recurrence', 'weekdays', 'kind']) {
      expect(req.request.body).not.toHaveProperty(field);
    }
    req.flush(game({ status: 'paused', kind: 'campaign', title: 'Нова назва' }));
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

  it.each(['unreachable', 'not_image', 'too_large', 'forbidden_address', 'timeout'])(
    'IMAGE_URL_INVALID %s: reason text next to the cover field',
    async (reason) => {
      await setup(5, game({ status: 'draft' }));
      await type('input[formcontrolname="coverUrl"]', 'https://img.example.com/x.png');
      await submit();
      http
        .expectOne('/api/games/5')
        .flush(
          { error: { code: 'IMAGE_URL_INVALID', details: { field: 'coverUrl', reason } } },
          { status: 422, statusText: 'Unprocessable' },
        );
      await settle();
      const coverField = q<HTMLInputElement>('input[formcontrolname="coverUrl"]').closest(
        '.field',
      )!;
      expect(coverField.textContent).toContain(`errors.imageUrl.${reason}`);
      expect(fixture.nativeElement.querySelector('.nri-alert')).toBeNull();
      await type('input[formcontrolname="coverUrl"]', 'https://img.example.com/y.png');
      expect(coverField.textContent).not.toContain('errors.imageUrl');
    },
  );

  it('an unchanged cover URL is not sent again in the PATCH; a new one is', async () => {
    const cover = 'https://img.example.com/cover.png';
    await setup(5, game({ status: 'draft', coverUrl: cover }));
    await type('input[formcontrolname="title"]', 'Нова назва');
    await submit();
    const req = http.expectOne('/api/games/5');
    expect(req.request.body).toMatchObject({ title: 'Нова назва' });
    expect(req.request.body).not.toHaveProperty('coverUrl');
    req.flush(game({ status: 'draft', title: 'Нова назва', coverUrl: cover }));
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

  describe('approximate start time', () => {
    it('«approximately» sends the window; a windowed game opens with «from» and «to»', async () => {
      await setup(5, game({ status: 'draft' }));
      q<HTMLElement>('.mode-approx button').click();
      await settle();
      // 19:00 за Києвом; типове вікно — 3 год.
      expect(matSelectedText(winSelect('window-from'))).toBe('19:00');
      expect(el.querySelector('nri-start-time-field input.time')).toBeNull();
      const to = winSelect('window-to');
      await pickIndex(to, 3, settle); // 2 год
      await submit();
      const req = http.expectOne('/api/games/5');
      expect(req.request.body).toMatchObject({
        startsAt: '2027-03-02T17:00:00.000Z',
        startWindowMinutes: 120,
      });
      req.flush(game({ status: 'draft', startWindowMinutes: 120 }));
      await settle();
    });

    it('a windowed game prefills the window; «exact time» clears it', async () => {
      await setup(5, game({ status: 'draft', startWindowMinutes: 90 }));
      await settle();
      expect(matSelectedText(winSelect('window-to'))).toContain('sessions.window.end');
      q<HTMLElement>('.mode-exact button').click();
      await settle();
      expect(q<HTMLInputElement>('nri-start-time-field input.time').value).toBe('19:00');
      await submit();
      const req = http.expectOne('/api/games/5');
      expect(req.request.body).toMatchObject({ startWindowMinutes: null });
      req.flush(game({ status: 'draft' }));
      await settle();
    });

    it('a dateless draft keeps its window: saved with startsAt null and the window', async () => {
      await setup(5, game({ status: 'draft', startWindowMinutes: 60 }));
      q<HTMLButtonElement>('button.clear-start').click();
      await settle();
      await submit();
      const req = http.expectOne('/api/games/5');
      expect(req.request.body).toMatchObject({ startsAt: null, startWindowMinutes: 60 });
      req.flush(
        game({ status: 'draft', startsAt: null, startWindowMinutes: 60, nextSessionAt: null }),
      );
      await settle();
      // «До» без дати — підписи за годинником, без помилок.
      expect(await openOptions(winSelect('window-to'), settle)).toHaveLength(24);
    });

    it('an off-grid start of a windowed game is snapped, so no hidden value is sent', async () => {
      await setup(
        5,
        game({ status: 'draft', startsAt: '2027-03-02T17:15:00.000Z', startWindowMinutes: 60 }),
      );
      await settle();
      expect(matSelectedText(winSelect('window-from'))).toBe('19:00');
      await submit();
      const req = http.expectOne('/api/games/5');
      expect(req.request.body).toMatchObject({ startsAt: '2027-03-02T17:00:00.000Z' });
      req.flush(game({ status: 'draft', startWindowMinutes: 60 }));
      await settle();
    });

    it('«approximately» on a game without a time starts at 18:00 and shows «to» as a clock time', async () => {
      await setup(5, game({ status: 'draft', startsAt: null, nextSessionAt: null }));
      q<HTMLElement>('.mode-approx button').click();
      await settle();
      expect(matSelectedText(winSelect('window-from'))).toBe('18:00');
      const to = matSelectedText(winSelect('window-to'));
      // Типове вікно 3 год: «до» — година завершення (ключ `end`), а не «через 3 год» (`length`).
      expect(to).toContain('sessions.window.end');
      expect(to).not.toContain('sessions.window.length');
    });

    it('a new game: «approximately» shows «from» 18:00 and «to» as clock times', async () => {
      await setup();
      q<HTMLElement>('.mode-approx button').click();
      await settle();
      expect(matSelectedText(winSelect('window-from'))).toBe('18:00');
      const text = matSelectedText(winSelect('window-to'));
      expect(text).toContain('sessions.window.end');
    });

    it('a dateless draft with a window but no time (restored draft) gets «from» 18:00', async () => {
      await setup(5, game({ status: 'draft', startsAt: null, startWindowMinutes: 60 }));
      await settle();
      expect(matSelectedText(winSelect('window-from'))).toBe('18:00');
      expect(matSelectedText(winSelect('window-to'))).toContain('sessions.window.end');
    });

    it('switching to «approximately» snaps an off-grid start down to 30 minutes', async () => {
      await setup(5, game({ status: 'draft', startsAt: '2027-03-02T17:15:00.000Z' }));
      q<HTMLElement>('.mode-approx button').click();
      await settle();
      expect(matSelectedText(winSelect('window-from'))).toBe('19:00');
    });

    it('a published game whose first session passed: changing only the window explains why it fails', async () => {
      await setup(5, game({ status: 'recruiting', startWindowMinutes: 60 }));
      await pickIndex(winSelect('window-to'), 3, settle);
      await submit();
      http
        .expectOne('/api/games/5')
        .flush({ error: { code: 'GAME_IN_PAST' } }, { status: 422, statusText: 'Unprocessable' });
      await settle();
      const dateField = q<HTMLInputElement>('input[formcontrolname="startDate"]').closest(
        '.field',
      )!;
      expect(dateField.textContent).toContain('games.form.errors.ruleInPast');
    });
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
    expect(isSelectDisabled(selectOf('system'))).toBe(false);
  });

  it('a 16-year-old can pick 16+ but not 18+/21+', async () => {
    const today = new Date();
    const teen = { ...me, birthDate: `${today.getFullYear() - 16}-01-01` };
    await setup(undefined, undefined, teen);
    const options = await openOptions(selectOf('ageRating'), settle);
    const disabled = options.filter(isOptionDisabled).map(optionText);
    expect(disabled).toEqual(['games.ageRating.18+', 'games.ageRating.21+']);
  });

  it('a 15-year-old cannot pick 16+ either', async () => {
    const today = new Date();
    const teen = { ...me, birthDate: `${today.getFullYear() - 15}-01-01` };
    await setup(undefined, undefined, teen);
    const options = await openOptions(selectOf('ageRating'), settle);
    const disabled = options.filter(isOptionDisabled).map(optionText);
    expect(disabled).toEqual(['games.ageRating.16+', 'games.ageRating.18+', 'games.ageRating.21+']);
  });

  describe('safety (optional)', () => {
    const details = () => q<HTMLDetailsElement>('nri-game-safety-fields details.safety');
    const kind = (k: 'lines' | 'veils') => `nri-game-safety-fields fieldset[data-kind="${k}"]`;
    const chip = (k: 'lines' | 'veils', i: number) =>
      el.querySelectorAll<HTMLButtonElement>(`${kind(k)} nri-warning-chip button.toggle`)[i]!;
    const addCustom = async (k: 'lines' | 'veils', text: string) => {
      await type(`${kind(k)} input.custom-input`, text);
      q<HTMLButtonElement>(`${kind(k)} button.add-custom`).click();
      await settle();
    };

    it('text left in a custom line input is added on blur, without Enter or the button', async () => {
      await setup();
      await type(`${kind('lines')} input.custom-input`, 'Павуки'); // type() fires blur
      expect(el.querySelector(`${kind('lines')} .custom-chip`)?.textContent).toContain('Павуки');
      expect(q<HTMLInputElement>(`${kind('lines')} input.custom-input`).value).toBe('');
      // Порожнє поле при виході нічого не додає.
      q<HTMLInputElement>(`${kind('lines')} input.custom-input`).dispatchEvent(new Event('blur'));
      await settle();
      expect(el.querySelectorAll(`${kind('lines')} .custom-chip`)).toHaveLength(1);
    });

    it('a duplicate left in the veil input on blur is not added twice', async () => {
      await setup();
      await type(`${kind('veils')} input.custom-input`, 'Павуки');
      await type(`${kind('veils')} input.custom-input`, ' павуки ');
      expect(el.querySelectorAll(`${kind('veils')} .custom-chip`)).toHaveLength(1);
    });

    it('text left in the custom content warning input is added on blur', async () => {
      await setup();
      await type('input.custom-warning-input', 'Клоуни');
      expect(el.querySelector('.chips.custom .custom-chip')?.textContent).toContain('Клоуни');
      expect(q<HTMLInputElement>('input.custom-warning-input').value).toBe('');
    });

    it('blur while the window has lost focus (alt-tab) adds nothing', async () => {
      await setup();
      const spy = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
      try {
        for (const sel of [`${kind('lines')} input.custom-input`, 'input.custom-warning-input']) {
          const input = q<HTMLInputElement>(sel);
          input.value = 'Напівнабране';
          input.dispatchEvent(new Event('input'));
          input.dispatchEvent(new Event('blur'));
          await settle();
          expect(input.value).toBe('Напівнабране');
        }
        expect(el.querySelectorAll('.custom-chip')).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('a new game: the section is collapsed and nothing is required', async () => {
      await setup();
      expect(details().open).toBe(false);
      expect(el.textContent).toContain('games.safety.optional');
      await fillValid();
      expect(publishButton().disabled).toBe(false);
      await submit();
      const req = http.expectOne('/api/games');
      expect(req.request.body).toMatchObject({
        safetyTools: [],
        lines: { warningIds: [], custom: [] },
        veils: { warningIds: [], custom: [] },
      });
      req.flush(game());
      await settle();
    });

    it('tools, lines and veils are sent; a topic picked as a veil leaves the lines', async () => {
      await setup();
      await fillValid();
      details().open = true;
      details().dispatchEvent(new Event('toggle'));
      await settle();
      q<HTMLInputElement>('li[data-tool="script_change"] input').click();
      await settle();
      q<HTMLInputElement>('li[data-tool="x_card"] input').click();
      await settle();
      chip('lines', 0).click(); // violence → межа
      await settle();
      chip('lines', 1).click(); // gore → межа
      await settle();
      chip('veils', 0).click(); // violence → завіса (зникає з меж)
      await settle();
      expect(chip('lines', 0).getAttribute('aria-pressed')).toBe('false');
      expect(chip('veils', 0).getAttribute('aria-pressed')).toBe('true');
      await addCustom('lines', '  Павуки  ');
      await addCustom('lines', 'павуки'); // повтор без урахування регістру — ігнорується
      await addCustom('veils', 'Павуки'); // переноситься із меж у завіси
      await addCustom('lines', 'Насильство над дітьми');
      await submit();
      const req = http.expectOne('/api/games');
      expect(req.request.body).toMatchObject({
        safetyTools: ['x_card', 'script_change'],
        lines: { warningIds: [2], custom: ['Насильство над дітьми'] },
        veils: { warningIds: [1], custom: ['Павуки'] },
      });
      req.flush(game());
      await settle();
    });

    it('a game with safety data opens the section; PATCH sends both lists whole', async () => {
      await setup(
        5,
        game({
          status: 'recruiting',
          safetyTools: ['open_door'],
          lines: { warningIds: [], custom: ['Павуки'] },
          veils: { warningIds: [2], custom: [] },
        }),
      );
      expect(details().open).toBe(true);
      expect(q<HTMLInputElement>('li[data-tool="open_door"] input').checked).toBe(true);
      expect(chip('veils', 1).getAttribute('aria-pressed')).toBe('true');
      q<HTMLButtonElement>(`${kind('lines')} button.remove-custom`).click();
      await settle();
      await submit();
      const req = http.expectOne('/api/games/5');
      expect(req.request.body).toMatchObject({
        safetyTools: ['open_door'],
        lines: { warningIds: [], custom: [] },
        veils: { warningIds: [2], custom: [] },
      });
      req.flush(game({ status: 'recruiting' }));
      await settle();
    });

    it('at most 10 custom texts per list', async () => {
      await setup();
      for (let i = 1; i <= 10; i++) await addCustom('lines', `Тема ${i}`);
      expect(el.querySelectorAll(`${kind('lines')} li.custom-chip`).length).toBe(10);
      expect(q<HTMLButtonElement>(`${kind('lines')} button.add-custom`).disabled).toBe(true);
    });

    it('a server validation issue on lines is shown in the safety section', async () => {
      await setup(5, game({ status: 'draft', lines: { warningIds: [], custom: ['Павуки'] } }));
      await submit();
      http.expectOne('/api/games/5').flush(
        {
          error: {
            code: 'VALIDATION',
            details: [{ code: 'too_big', path: ['lines', 'custom', 0], message: 'x' }],
          },
        },
        { status: 400, statusText: 'Bad Request' },
      );
      await settle();
      expect(q<HTMLElement>(kind('lines')).textContent).toContain('games.form.errors.invalid');
    });

    it('a restored local copy brings back the safety values', async () => {
      localStorage.setItem(
        'nri.gameDraft.1.new',
        JSON.stringify({
          v: 1,
          savedAt: Date.now(),
          updatedAt: null,
          values: {
            title: 'Чернетка',
            safetyTools: ['check_ins', 'bogus'],
            veils: { warningIds: [1], custom: ['Павуки'] },
          },
        }),
      );
      await setup();
      expect(details().open).toBe(true);
      // Некоректний список інструментів пропускається цілком.
      expect(q<HTMLInputElement>('li[data-tool="check_ins"] input').checked).toBe(false);
      expect(chip('veils', 0).getAttribute('aria-pressed')).toBe('true');
      expect(q<HTMLElement>(kind('veils')).textContent).toContain('Павуки');
    });
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

    it('an existing game without safety data stays clean: no autosave, PATCH sends empty lists', async () => {
      await setup(5, game({ status: 'draft' }));
      await debounce();
      expect(localStorage.getItem('nri.gameDraft.1.5')).toBeNull();
      expect(el.querySelector('.restored-notice')).toBeNull();
      await type('input[formcontrolname="title"]', 'Нова назва');
      await submit();
      const req = http.expectOne('/api/games/5');
      expect(req.request.method).toBe('PATCH');
      expect(req.request.body).toMatchObject({
        safetyTools: [],
        lines: { warningIds: [], custom: [] },
        veils: { warningIds: [], custom: [] },
      });
      req.flush(game({ status: 'draft' }));
      await settle();
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
      expect(q<HTMLInputElement>('nri-start-time-field input.time').value).toBe('19:00');
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
