import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { NOTE_BODY_MAX, type MeDto, type NoteDto, type NoteUpdateInput } from '@nri/shared';
import { NoteEditor } from './note-editor';
import { AuthStore } from '../../../core/auth/auth.store';
import { noteDraftKey } from '../../../core/notes/note-draft-storage';
import type { NoteSource } from '../../../core/notes/notes.api';
import { SocketService } from '../../../core/realtime/socket.service';

const me = {
  id: 5,
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
  uiPrefs: { tearAnimation: true, sendAnimation: true },
  identities: [],
} satisfies MeDto;
const DRAFT_KEY = noteDraftKey(5, 'game_private.7');

/** Ручне джерело: кожен запит — окремий `Subject`, який тест завершує сам. */
class FakeSource implements NoteSource {
  key = 'game_private.7';
  url = '/api/games/7/notes/private';
  loads: Subject<NoteDto>[] = [];
  saves: { input: NoteUpdateInput; reply: Subject<NoteDto> }[] = [];
  load() {
    const s = new Subject<NoteDto>();
    this.loads.push(s);
    return s;
  }
  save(input: NoteUpdateInput) {
    const reply = new Subject<NoteDto>();
    this.saves.push({ input, reply });
    return reply;
  }
}

const note = (body: string, version: number): NoteDto => ({
  body,
  version,
  updatedAt: version ? '2026-11-20T10:00:00.000Z' : null,
});

function reply<T>(s: Subject<T>, value: T) {
  s.next(value);
  s.complete();
}

function conflict(s: Subject<NoteDto>, body: string, version: number) {
  s.error(
    new HttpErrorResponse({
      status: 409,
      error: { error: { code: 'NOTE_CONFLICT', details: { body, version } } },
    }),
  );
}

function notFound() {
  return new HttpErrorResponse({ status: 404, error: { error: { code: 'NOT_FOUND' } } });
}

describe('NoteEditor', () => {
  let fixture: ComponentFixture<NoteEditor>;
  let source: FakeSource;

  const el = () => fixture.nativeElement as HTMLElement;
  const area = () => el().querySelector<HTMLTextAreaElement>('textarea')!;
  const status = () => el().querySelector('.status')!.textContent!.trim();
  const tick = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
  };
  const type = (value: string) => {
    area().value = value;
    area().dispatchEvent(new Event('input'));
  };

  async function create(initial: NoteDto | null = null, reuse = false) {
    if (!reuse) {
      vi.useFakeTimers();
      TestBed.configureTestingModule({
        providers: [
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
      source = new FakeSource();
    }
    fixture = TestBed.createComponent(NoteEditor);
    fixture.componentRef.setInput('source', source);
    fixture.componentRef.setInput('label', 'notes.private.game');
    fixture.componentRef.setInput('initial', initial);
    await tick();
  }

  afterEach(() => {
    fixture?.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('loads the note and shows it in a labelled textarea', async () => {
    await create();
    expect(source.loads).toHaveLength(1);
    reply(source.loads[0]!, note('Рядок 1\nРядок 2', 3));
    await tick();
    expect(area().value).toBe('Рядок 1\nРядок 2');
    expect(area().maxLength).toBe(NOTE_BODY_MAX);
    const label = el().querySelector(`label[for="${area().id}"]`);
    expect(label!.textContent).toContain('notes.private.game');
    expect(el().querySelector('.status-area')!.getAttribute('aria-live')).toBe('polite');
  });

  it('uses the given initial note without loading', async () => {
    await create(note('Моя сторінка', 2));
    expect(source.loads).toHaveLength(0);
    expect(area().value).toBe('Моя сторінка');
  });

  it('autosaves 1 s after typing with the known version', async () => {
    await create(note('', 0));
    type('Привіт');
    await tick(900);
    expect(source.saves).toHaveLength(0);
    await tick(100);
    expect(source.saves.map((s) => s.input)).toEqual([{ body: 'Привіт', version: 0 }]);
    expect(status()).toBe('notes.status.saving');
    expect(el().querySelector('.status')!.closest('[aria-live]')).not.toBeNull();
    reply(source.saves[0]!.reply, note('Привіт', 1));
    await tick();
    expect(status()).toBe('notes.status.saved');

    type('Привіт!');
    await tick(1000);
    expect(source.saves[1]!.input).toEqual({ body: 'Привіт!', version: 1 });
  });

  it('autosave does not send anything without changes', async () => {
    await create(note('Текст', 4));
    type('Текст!');
    type('Текст');
    await tick(1500);
    area().dispatchEvent(new Event('blur'));
    await tick(1500);
    expect(source.saves).toHaveLength(0);
  });

  it('flushes a pending change on blur and on destroy', async () => {
    await create(note('', 0));
    type('a');
    area().dispatchEvent(new Event('blur'));
    await tick();
    expect(source.saves.map((s) => s.input.body)).toEqual(['a']);
    reply(source.saves[0]!.reply, note('a', 1));
    await tick();

    type('ab');
    fixture.destroy();
    expect(source.saves.map((s) => s.input)).toEqual([
      { body: 'a', version: 0 },
      { body: 'ab', version: 1 },
    ]);
  });

  it('on conflict shows both versions; «keep mine» re-saves with the server version', async () => {
    await create(note('Старе', 1));
    type('Моє');
    await tick(1000);
    conflict(source.saves[0]!.reply, 'Чуже', 5);
    await tick();
    expect(status()).toBe('notes.status.conflict');
    const panel = el().querySelector<HTMLElement>('.conflict')!;
    expect(panel.getAttribute('role')).toBe('alert');
    expect(panel.querySelector('.mine')!.textContent).toContain('Моє');
    expect(panel.querySelector('.theirs')!.textContent).toContain('Чуже');

    // Під час конфлікту автозбереження не перезаписує серверну версію.
    type('Моє 2');
    await tick(1500);
    expect(source.saves).toHaveLength(1);

    panel.querySelector<HTMLButtonElement>('button.keep-mine')!.click();
    await tick();
    expect(source.saves[1]!.input).toEqual({ body: 'Моє 2', version: 5 });
    reply(source.saves[1]!.reply, note('Моє 2', 6));
    await tick();
    expect(el().querySelector('.conflict')).toBeNull();
    expect(status()).toBe('notes.status.saved');
  });

  it('«take theirs» replaces the text with the server version without saving', async () => {
    await create(note('Старе', 1));
    type('Моє');
    await tick(1000);
    conflict(source.saves[0]!.reply, 'Чуже', 5);
    await tick();
    el().querySelector<HTMLButtonElement>('.conflict button.take-theirs')!.click();
    await tick(1500);
    expect(area().value).toBe('Чуже');
    expect(el().querySelector('.conflict')).toBeNull();
    expect(source.saves).toHaveLength(1);
    type('Чуже+');
    await tick(1000);
    expect(source.saves[1]!.input).toEqual({ body: 'Чуже+', version: 5 });
  });

  it('shows an error status when saving fails', async () => {
    await create(note('', 0));
    type('x');
    await tick(1000);
    source.saves[0]!.reply.error(new HttpErrorResponse({ status: 500 }));
    await tick();
    expect(status()).toBe('notes.status.error');
  });

  it('404 on save (session removed): draft dropped, text kept read-only with a message', async () => {
    await create(note('', 0));
    type('Важливий текст');
    await tick(1000);
    source.saves[0]!.reply.error(notFound());
    await tick();
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(area().value).toBe('Важливий текст');
    expect(area().readOnly).toBe(true);
    expect(el().querySelector('.gone')!.textContent).toContain('notes.gone');
    // Більше не зберігає й не пише копію — ні на введення, ні на знищення.
    type('Ще');
    await tick(1000);
    fixture.destroy();
    expect(source.saves).toHaveLength(1);
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('a stored draft of a removed session is shown once and dropped', async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ body: 'Чернетка' }));
    await create();
    source.loads[0]!.error(notFound());
    await tick();
    expect(area().value).toBe('Чернетка');
    expect(area().readOnly).toBe(true);
    expect(el().querySelector('.gone')).not.toBeNull();
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('shows a character counter near the limit', async () => {
    await create(note('', 0));
    expect(el().querySelector('.counter')).toBeNull();
    type('x'.repeat(NOTE_BODY_MAX - 100));
    await tick();
    expect(el().querySelector('.counter')!.textContent).toContain('notes.counter');
  });

  it('destroyed while saving: newer text is sent once more with the returned version', async () => {
    await create(note('', 0));
    type('a');
    await tick(1000);
    expect(source.saves).toHaveLength(1);
    type('ab');
    fixture.destroy();
    // Запит іще йде — другий не дублюємо одночасно.
    expect(source.saves).toHaveLength(1);
    reply(source.saves[0]!.reply, note('a', 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(source.saves.map((x) => x.input)).toEqual([
      { body: 'a', version: 0 },
      { body: 'ab', version: 1 },
    ]);
    reply(source.saves[1]!.reply, note('ab', 2));
    await vi.advanceTimersByTimeAsync(0);
    expect(source.saves).toHaveLength(2);
  });

  it('closed with an open conflict: «mine» is kept and offered again on the next open', async () => {
    await create(note('Старе', 1));
    type('Моє');
    await tick(1000);
    conflict(source.saves[0]!.reply, 'Чуже', 5);
    await tick();
    type('Моє, остаточне');
    fixture.destroy();
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!).body).toBe('Моє, остаточне');

    // Наступне відкриття: актуальна версія перечитується навіть за наявності `initial`.
    await create(note('Старе', 1), true);
    expect(source.loads).toHaveLength(1);
    reply(source.loads[0]!, note('Чуже 2', 6));
    await tick();
    expect(status()).toBe('notes.status.conflict');
    const panel = el().querySelector<HTMLElement>('.conflict')!;
    expect(panel.querySelector('.mine')!.textContent).toContain('Моє, остаточне');
    expect(panel.querySelector('.theirs')!.textContent).toContain('Чуже 2');

    panel.querySelector<HTMLButtonElement>('button.keep-mine')!.click();
    await tick();
    expect(source.saves.at(-1)!.input).toEqual({ body: 'Моє, остаточне', version: 6 });
    reply(source.saves.at(-1)!.reply, note('Моє, остаточне', 7));
    await tick();
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('«take theirs» drops the stored draft; logout clears all drafts', async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ body: 'Чернетка' }));
    await create(note('Старе', 1));
    reply(source.loads[0]!, note('Чуже', 3));
    await tick();
    el().querySelector<HTMLButtonElement>('.conflict button.take-theirs')!.click();
    await tick();
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(area().value).toBe('Чуже');

    localStorage.setItem(DRAFT_KEY, JSON.stringify({ body: 'Чернетка' }));
    TestBed.inject(AuthStore).setMe(null);
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('pagehide sends the pending change with keepalive and the CSRF header', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    document.cookie = 'nri_csrf=tok123';
    await create(note('Текст', 4));
    type('Текст!');
    window.dispatchEvent(new Event('pagehide'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/games/7/notes/private');
    expect(init).toMatchObject({ method: 'PUT', keepalive: true });
    expect((init!.headers as Record<string, string>)['X-CSRF-Token']).toBe('tok123');
    expect(JSON.parse(init!.body as string)).toEqual({ body: 'Текст!', version: 4 });
    // Відкладений таймер скасовано — HttpClient-запит не дублюється.
    await tick(1500);
    expect(source.saves).toHaveLength(0);
    document.cookie = 'nri_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  });
  it('retry after a failed restore load re-runs the draft restore', async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ body: 'Чернетка' }));
    await create(note('Старе', 1));
    source.loads[0]!.error(new HttpErrorResponse({ status: 500 }));
    await tick();
    el().querySelector<HTMLButtonElement>('.load-error button')!.click();
    await tick();
    expect(source.loads).toHaveLength(2);
    reply(source.loads[1]!, note('Чуже', 3));
    await tick();
    expect(status()).toBe('notes.status.conflict');
    const panel = el().querySelector<HTMLElement>('.conflict')!;
    expect(panel.querySelector('.mine')!.textContent).toContain('Чернетка');
    expect(panel.querySelector('.theirs')!.textContent).toContain('Чуже');
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!).body).toBe('Чернетка');
  });

  it('retry after a failed load without a draft simply reloads', async () => {
    await create();
    source.loads[0]!.error(new HttpErrorResponse({ status: 500 }));
    await tick();
    el().querySelector<HTMLButtonElement>('.load-error button')!.click();
    await tick();
    reply(source.loads[1]!, note('Текст', 2));
    await tick();
    expect(area().value).toBe('Текст');
    expect(el().querySelector('.conflict')).toBeNull();
  });

  it('during a conflict the local copy is written with a 500 ms pause, flushed on destroy', async () => {
    await create(note('Старе', 1));
    type('Моє');
    await tick(1000);
    conflict(source.saves[0]!.reply, 'Чуже', 5);
    await tick();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    type('Моє 1');
    type('Моє 12');
    type('Моє 123');
    expect(setItem).not.toHaveBeenCalled();
    await tick(500);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!).body).toBe('Моє 123');

    type('Моє 1234');
    fixture.destroy();
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!).body).toBe('Моє 1234');
  });

  it('a pending conflict draft write is flushed on pagehide and cancelled by «take theirs»', async () => {
    await create(note('Старе', 1));
    type('Моє');
    await tick(1000);
    conflict(source.saves[0]!.reply, 'Чуже', 5);
    await tick();
    type('Моє, нове');
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!).body).toBe('Моє, нове');

    type('Моє, ще новіше');
    el().querySelector<HTMLButtonElement>('.conflict button.take-theirs')!.click();
    await tick(1000);
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});
