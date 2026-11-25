import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { NoteDto, SharedNotePageDto } from '@nri/shared';
import { firstValueFrom, map } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth.store';
import { formatDateTime, viewerTimeZone } from '../../../core/i18n/dates';
import { NotesApi, type NoteSource } from '../../../core/notes/notes.api';
import { NoteEditor } from '../note-editor/note-editor';

const EMPTY_NOTE: NoteDto = { body: '', version: 0, updatedAt: null };

/**
 * Спільна нотатка гравців (майстру не показується): моя сторінка — редагована з
 * автозбереженням, сторінки інших гравців — лише для читання (колишні учасники позначені).
 * «Оновити» перечитує чужі сторінки, не чіпаючи мою, що редагується.
 */
@Component({
  selector: 'nri-shared-player-notes',
  imports: [MatButtonModule, MatIconModule, TranslatePipe, NoteEditor],
  templateUrl: './shared-player-notes.html',
  styleUrl: './shared-player-notes.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SharedPlayerNotes {
  private readonly api = inject(NotesApi);
  private readonly auth = inject(AuthStore);

  readonly gameId = input.required<number>();

  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly refreshing = signal(false);
  protected readonly refreshFailed = signal(false);
  /**
   * Моя сторінка — з першого завантаження; лише активному учасникові (колишній не редагує).
   */
  protected readonly mine = signal<NoteDto | null>(null);
  /** Непорожні сторінки інших гравців. */
  protected readonly others = signal<SharedNotePageDto[]>([]);
  /**
   * Моя сторінка. `load` редактор викликає лише для відновлення незбереженого тексту
   * (перечитати актуальну версію), звичайно ж бере вже завантажену сторінку (`initial`).
   */
  protected readonly source = computed<NoteSource>(() => {
    const id = this.gameId();
    return this.api.sharedPage(id, () =>
      this.api.shared(id).pipe(map(({ pages }) => this.ownPage(pages) ?? EMPTY_NOTE)),
    );
  });

  private readonly zone = computed(() => viewerTimeZone(this.auth.me()));

  constructor() {
    effect(() => {
      const id = this.gameId();
      untracked(() => void this.load(id));
    });
  }

  protected updated(p: SharedNotePageDto): string {
    return p.updatedAt ? formatDateTime(p.updatedAt, this.zone()) : '';
  }

  protected async retry(): Promise<void> {
    await this.load(this.gameId());
  }

  protected async refresh(): Promise<void> {
    if (this.refreshing()) return;
    this.refreshing.set(true);
    this.refreshFailed.set(false);
    try {
      await this.load(this.gameId(), true);
    } finally {
      this.refreshing.set(false);
    }
  }

  private ownPage(pages: SharedNotePageDto[]): SharedNotePageDto | undefined {
    const myId = this.auth.me()?.publicId;
    return pages.find((p) => p.author.publicId === myId && !p.formerMember);
  }

  private async load(gameId: number, silent = false): Promise<void> {
    if (!silent) this.state.set('loading');
    try {
      const { pages } = await firstValueFrom(this.api.shared(gameId));
      const own = this.ownPage(pages);
      if (!this.mine() && own) this.mine.set(own);
      this.others.set(pages.filter((p) => p !== own && p.body.trim() !== ''));
      this.state.set('ready');
    } catch {
      if (silent) this.refreshFailed.set(true);
      else this.state.set('error');
    }
  }
}
