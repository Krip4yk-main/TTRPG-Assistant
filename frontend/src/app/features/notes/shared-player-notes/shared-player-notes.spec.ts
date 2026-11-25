import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { MeDto, SharedNotesDto } from '@nri/shared';
import { SharedPlayerNotes } from './shared-player-notes';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';

const me = {
  id: 1,
  publicId: 'mmmmmmmmmm',
  nickname: 'Frodo',
  avatarUrl: null,
  birthDate: '1990-01-01',
  role: 'user',
  status: 'active',
  timezone: 'Europe/Kyiv',
  locale: 'uk',
  uiTheme: 'quest-board',
  availableThemes: ['quest-board'],
  identities: [],
} satisfies MeDto;

const author = (publicId: string, nickname: string | null) => ({
  publicId,
  nickname,
  avatarUrl: null,
});

const notes: SharedNotesDto = {
  pages: [
    {
      author: author('ssssssssss', 'Sam'),
      formerMember: false,
      body: 'Сем: мапа\nдругий рядок',
      version: 2,
      updatedAt: '2026-11-20T10:00:00.000Z',
    },
    {
      author: author(me.publicId, me.nickname),
      formerMember: false,
      body: 'Моя сторінка',
      version: 4,
      updatedAt: '2026-11-21T10:00:00.000Z',
    },
    {
      author: author('gggggggggg', 'Gollum'),
      formerMember: true,
      body: 'Моя прелесть',
      version: 1,
      updatedAt: '2026-11-01T10:00:00.000Z',
    },
    {
      author: author('eeeeeeeeee', 'Empty'),
      formerMember: false,
      body: '',
      version: 0,
      updatedAt: null,
    },
  ],
};

describe('SharedPlayerNotes', () => {
  let fixture: ComponentFixture<SharedPlayerNotes>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

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
    TestBed.inject(AuthStore).setMe(me);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(SharedPlayerNotes);
    fixture.componentRef.setInput('gameId', 7);
    await settle();
    http.expectOne('/api/games/7/notes/shared').flush(notes);
    await settle();
  });

  afterEach(() => http.verify());

  it('my page is editable and saves to the shared note', async () => {
    const mine = el().querySelector<HTMLElement>('.my-page')!;
    const area = mine.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(area.value).toBe('Моя сторінка');
    area.value = 'Моя сторінка!';
    area.dispatchEvent(new Event('input'));
    area.dispatchEvent(new Event('blur'));
    await settle();
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === '/api/games/7/notes/shared');
    expect(put.request.body).toEqual({ body: 'Моя сторінка!', version: 4 });
    put.flush({ body: 'Моя сторінка!', version: 5, updatedAt: '2026-11-25T10:00:00.000Z' });
    await settle();
  });

  it('other pages are read-only, the former member is flagged, empty pages are skipped', () => {
    const others = [...el().querySelectorAll<HTMLElement>('.other-page')];
    expect(others.map((p) => p.querySelector('.author')!.textContent!.trim())).toEqual([
      'Sam',
      'Gollum',
    ]);
    expect(others[0]!.querySelector('textarea')).toBeNull();
    expect(others[0]!.querySelector('.text')!.textContent).toContain('Сем: мапа\nдругий рядок');
    expect(others[0]!.querySelector('.former')).toBeNull();
    expect(others[1]!.querySelector('.former')!.textContent).toContain('notes.shared.former');
    expect(el().querySelectorAll('textarea')).toHaveLength(1);
  });

  it('«refresh» reloads other pages', async () => {
    el().querySelector<HTMLButtonElement>('button.refresh')!.click();
    await settle();
    http.expectOne('/api/games/7/notes/shared').flush({ pages: [notes.pages[1]!] });
    await settle();
    expect(el().querySelectorAll('.other-page')).toHaveLength(0);
    expect(el().textContent).toContain('notes.shared.noOthers');
  });

  it('a former member gets no editable page', async () => {
    const other = TestBed.createComponent(SharedPlayerNotes);
    other.componentRef.setInput('gameId', 8);
    other.detectChanges();
    await other.whenStable();
    http.expectOne('/api/games/8/notes/shared').flush({
      pages: [{ ...notes.pages[1]!, formerMember: true }],
    });
    other.detectChanges();
    await other.whenStable();
    other.detectChanges();
    const host = other.nativeElement as HTMLElement;
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.querySelector('.other-page .former')).not.toBeNull();
  });
});
