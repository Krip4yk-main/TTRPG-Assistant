import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { AdminCatalogSystemDto, CatalogDto, MeDto } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { CatalogStore } from '../../../core/catalog/catalog.store';
import { SocketService } from '../../../core/realtime/socket.service';
import { AdminCatalog } from './catalog';

const me = {
  id: 1,
  publicId: 'abcdefghjk',
  nickname: 'Admin',
  avatarUrl: null,
  birthDate: '1990-01-01',
  role: 'admin',
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
} satisfies MeDto;

const catalog: CatalogDto = {
  systems: [{ id: 1, slug: 'dnd5e', name: 'D&D 5e', defaultGenreId: 10 }],
  genres: [
    { id: 10, slug: 'fantasy' },
    { id: 11, slug: 'horror' },
  ],
  contentWarnings: [],
};

const dnd: AdminCatalogSystemDto = {
  id: 1,
  slug: 'dnd5e',
  name: 'D&D 5e',
  defaultGenreId: 10,
  sort: 10,
  isActive: true,
};
const coc: AdminCatalogSystemDto = {
  id: 2,
  slug: 'coc7e',
  name: 'Call of Cthulhu',
  defaultGenreId: 11,
  sort: 20,
  isActive: false,
};

describe('AdminCatalog', () => {
  let fixture: ComponentFixture<AdminCatalog>;
  let http: HttpTestingController;
  let el: HTMLElement;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const overlay = () => document.querySelector<HTMLElement>('.cdk-overlay-container')!;
  const clearOverlay = () =>
    document.querySelectorAll('.cdk-overlay-container').forEach((c) => (c.innerHTML = ''));
  const row = (id: number) => el.querySelector<HTMLElement>(`[data-system="${id}"]`)!;
  const dialogButton = (text: string) =>
    [...overlay().querySelectorAll<HTMLButtonElement>('mat-dialog-actions button')].find((b) =>
      b.textContent!.includes(text),
    )!;
  const typeIn = async (selector: string, value: string) => {
    const input = overlay().querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  };
  const chooseGenre = async (id: number) => {
    const select = overlay().querySelector<HTMLSelectElement>('select.genre')!;
    select.selectedIndex = [...select.options].findIndex((o) =>
      o.textContent!.includes(id === 11 ? 'genres.horror' : 'genres.fantasy'),
    );
    select.dispatchEvent(new Event('change'));
    await settle();
  };
  const submitDialog = async () => {
    overlay().querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    await settle();
  };
  const eventually = (check: () => void) =>
    vi.waitFor(() => {
      fixture.detectChanges();
      check();
    });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminCatalog],
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
    TestBed.inject(AuthStore).setMe(me);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AdminCatalog);
    el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle();
    http.expectOne('/api/admin/catalog/systems').flush({ items: [dnd, coc] });
    http.expectOne('/api/catalog').flush(catalog);
    await eventually(() => expect(el.querySelector('[data-system="2"]')).not.toBeNull());
  });

  afterEach(() => {
    http.verify();
    el.remove();
    clearOverlay();
  });

  it('lists every system including disabled ones, with slug, genre and order', () => {
    expect(row(1).textContent).toContain('D&D 5e');
    expect(row(1).textContent).toContain('dnd5e');
    expect(row(1).textContent).toContain('genres.fantasy');
    expect(row(1).textContent).toContain('admin.catalog.active');
    expect(row(2).classList).toContain('inactive');
    expect(row(2).textContent).toContain('admin.catalog.inactive');
    expect(row(1).querySelector('button.toggle')!.textContent).toContain('admin.catalog.disable');
    expect(row(2).querySelector('button.toggle')!.textContent).toContain('admin.catalog.enable');
  });

  it('adds a system: validates the slug, then POSTs and refreshes the public catalog', async () => {
    el.querySelector<HTMLButtonElement>('button.add-system')!.click();
    await settle();
    expect(overlay().textContent).toContain('admin.catalog.createTitle');
    expect(overlay().querySelector<HTMLInputElement>('input.sort')!.value).toBe('30');
    await typeIn('input.name', '  Blades in the Dark ');
    await typeIn('input.slug', 'Blades In Dark');
    await chooseGenre(11);
    await submitDialog();
    expect(overlay().textContent).toContain('admin.catalog.errors.slugFormat');
    http.expectNone('/api/admin/catalog/systems');

    await typeIn('input.slug', 'blades-in-the-dark');
    await submitDialog();
    const req = http.expectOne('/api/admin/catalog/systems');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      name: 'Blades in the Dark',
      slug: 'blades-in-the-dark',
      defaultGenreId: 11,
      sort: 30,
    });
    req.flush({
      id: 3,
      slug: 'blades-in-the-dark',
      name: 'Blades in the Dark',
      defaultGenreId: 11,
      sort: 30,
      isActive: true,
    });
    await eventually(() => expect(row(3).textContent).toContain('Blades in the Dark'));
    expect(el.textContent).toContain('admin.catalog.done.created');
    // Форми ігор отримають свіжий каталог.
    const reload = TestBed.inject(CatalogStore).load();
    http.expectOne('/api/catalog').flush(catalog);
    await reload;
  });

  it('a taken slug is shown next to the field', async () => {
    el.querySelector<HTMLButtonElement>('button.add-system')!.click();
    await settle();
    await typeIn('input.name', 'Ще D&D');
    await typeIn('input.slug', 'dnd5e');
    await chooseGenre(10);
    await submitDialog();
    http
      .expectOne('/api/admin/catalog/systems')
      .flush({ error: { code: 'CATALOG_SLUG_TAKEN' } }, { status: 409, statusText: 'C' });
    await eventually(() => expect(overlay().textContent).toContain('errors.CATALOG_SLUG_TAKEN'));
    dialogButton('common.cancel').click();
    await settle();
  });

  it('edits name, genre and order with a PATCH of the changed fields only', async () => {
    row(1).querySelector<HTMLButtonElement>('button.edit')!.click();
    await settle();
    expect(overlay().querySelector('input.slug')).toBeNull();
    expect(overlay().textContent).toContain('dnd5e');
    await typeIn('input.name', 'D&D 5e (2014)');
    await chooseGenre(11);
    await submitDialog();
    const req = http.expectOne('/api/admin/catalog/systems/1');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ name: 'D&D 5e (2014)', defaultGenreId: 11 });
    req.flush({ ...dnd, name: 'D&D 5e (2014)', defaultGenreId: 11 });
    await eventually(() => expect(row(1).textContent).toContain('D&D 5e (2014)'));
    expect(row(1).textContent).toContain('genres.horror');
  });

  it('saving the edit dialog without changes sends nothing', async () => {
    row(1).querySelector<HTMLButtonElement>('button.edit')!.click();
    await settle();
    await submitDialog();
    http.expectNone('/api/admin/catalog/systems/1');
  });

  it('disabling asks for confirmation; only then PATCHes isActive', async () => {
    row(1).querySelector<HTMLButtonElement>('button.toggle')!.click();
    await settle();
    expect(overlay().textContent).toContain('admin.catalog.disableTitle');
    dialogButton('common.cancel').click();
    await settle();
    http.expectNone('/api/admin/catalog/systems/1');

    row(1).querySelector<HTMLButtonElement>('button.toggle')!.click();
    await settle();
    dialogButton('admin.catalog.disable').click();
    await settle();
    // Діалог підтвердження закривається з анімацією.
    const req = await vi.waitFor(() => http.expectOne('/api/admin/catalog/systems/1'));
    expect(req.request.body).toEqual({ isActive: false });
    req.flush({ ...dnd, isActive: false });
    await eventually(() => expect(row(1).classList).toContain('inactive'));
    expect(el.textContent).toContain('admin.catalog.done.disabled');
  });

  it('enabling a disabled system', async () => {
    row(2).querySelector<HTMLButtonElement>('button.toggle')!.click();
    await settle();
    expect(overlay().textContent).toContain('admin.catalog.enableTitle');
    dialogButton('admin.catalog.enable').click();
    await settle();
    // Поки запит іде — інші дії з системами недоступні.
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(row(2).querySelector<HTMLButtonElement>('button.edit')!.disabled).toBe(true);
    });
    // Діалог підтвердження закривається з анімацією.
    const req = await vi.waitFor(() => http.expectOne('/api/admin/catalog/systems/2'));
    expect(req.request.body).toEqual({ isActive: true });
    req.flush({ ...coc, isActive: true });
    await eventually(() => expect(row(2).classList).not.toContain('inactive'));
  });
});
