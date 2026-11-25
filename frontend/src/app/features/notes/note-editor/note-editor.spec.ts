import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { NOTE_BODY_MAX, type NoteDto, type NoteUpdateInput } from '@nri/shared';
import { NoteEditor } from './note-editor';
import type { NoteSource } from '../../../core/notes/notes.api';

/** Ручне джерело: кожен запит — окремий `Subject`, який тест завершує сам. */
class FakeSource implements NoteSource {
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

  async function create(initial: NoteDto | null = null) {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ providers: [provideTranslateService()] });
    source = new FakeSource();
    fixture = TestBed.createComponent(NoteEditor);
    fixture.componentRef.setInput('source', source);
    fixture.componentRef.setInput('label', 'notes.private.game');
    fixture.componentRef.setInput('initial', initial);
    await tick();
  }

  afterEach(() => {
    fixture?.destroy();
    vi.useRealTimers();
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

  it('shows a character counter near the limit', async () => {
    await create(note('', 0));
    expect(el().querySelector('.counter')).toBeNull();
    type('x'.repeat(NOTE_BODY_MAX - 100));
    await tick();
    expect(el().querySelector('.counter')!.textContent).toContain('notes.counter');
  });
});
