import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { of, Subject } from 'rxjs';
import {
  GM_CRITERIA,
  PLAYER_CRITERIA,
  type MeDto,
  type RatingTargetDto,
  type RatingTargetsDto,
} from '@nri/shared';
import { RatePage } from './rate-page';
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
  uiPrefs: { tearAnimation: true },
  identities: [],
} satisfies MeDto;

const gm: RatingTargetDto = {
  publicId: 'gggggggggg',
  nickname: 'Gandalf',
  avatarUrl: null,
  role: 'gm',
  state: 'open',
  closesAt: '2026-12-12T10:00:00.000Z',
};
const player: RatingTargetDto = {
  publicId: 'pppppppppp',
  nickname: 'Sam',
  avatarUrl: null,
  role: 'player_from_player',
  state: 'open',
  closesAt: null,
};
const finalSet = (targets: RatingTargetDto[]): RatingTargetsDto => ({
  gameId: 7,
  gameTitle: 'Туман над Дніпром',
  sessionId: null,
  sessionStartsAt: null,
  kind: 'final',
  targets,
});

describe('RatePage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let dialogOpen: ReturnType<typeof vi.fn>;

  /** Ланцюжки `await` після відповіді (помилка → перечитування) — ще один макротакт. */
  const settle = async () => {
    harness.detectChanges();
    await harness.fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    harness.detectChanges();
  };
  const el = () => harness.routeNativeElement!;
  const target = (id: string) => el().querySelector<HTMLElement>(`[data-target="${id}"]`)!;
  const targetsReq = () =>
    http.expectOne((r) => r.method === 'GET' && r.url === '/api/games/7/ratings/targets');
  const postReq = () =>
    http.expectOne((r) => r.method === 'POST' && r.url === '/api/games/7/ratings');
  const flushPending = () => http.match('/api/me/ratings/pending').forEach((r) => r.flush([]));
  const click = async (node: HTMLElement | null) => {
    node!.click();
    await settle();
  };

  async function open(url: string) {
    dialogOpen = vi.fn();
    await TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(
          [
            { path: 'games/:id/rate', component: RatePage },
            { path: '**', children: [] },
          ],
          withComponentInputBinding(),
        ),
        provideTranslateService(),
        { provide: MatDialog, useValue: { open: dialogOpen } },
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
    });
    TestBed.inject(AuthStore).setMe(me);
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url, RatePage);
    await settle();
  }

  /** Відкрити підсумкову оцінку гри 7 з назвою гри. */
  async function openFinal(targets: RatingTargetDto[]) {
    await open('/games/7/rate');
    const req = targetsReq();
    expect(req.request.params.has('sessionId')).toBe(false);
    req.flush(finalSet(targets));
    await settle();
    // Назва гри — з набору цілей, без окремого запиту гри.
    http.expectNone('/api/games/7');
  }

  afterEach(() => {
    flushPending();
    http.verify();
  });

  it('shows the game, kind, each target with its role criteria and deadline', async () => {
    await openFinal([gm, player]);
    expect(el().querySelector('.game-title')!.textContent).toContain('Туман над Дніпром');
    expect(el().querySelector('.kind')!.textContent).toContain('ratings.page.final');
    const criteria = (id: string) =>
      [...target(id).querySelectorAll<HTMLElement>('.criterion')].map(
        (c) => c.dataset['criterion'],
      );
    expect(criteria(gm.publicId)).toEqual([...GM_CRITERIA]);
    expect(criteria(player.publicId)).toEqual([...PLAYER_CRITERIA]);
    expect(target(gm.publicId).querySelector('.closes')!.textContent).toContain(
      'ratings.closes.until',
    );
    expect(target(player.publicId).querySelector('.closes')!.textContent).toContain(
      'ratings.closes.none',
    );
    // Пояснення: незмінність після надсилання й хто бачить текст.
    expect(target(gm.publicId).textContent).toContain('ratings.form.final');
    expect(target(gm.publicId).textContent).toContain('ratings.form.commentHint');
    expect(target(gm.publicId).querySelector('textarea')!.maxLength).toBe(2000);
  });

  it('overall is required: no request until chosen, then sends criteria and comment', async () => {
    await openFinal([gm, player]);
    flushPending();
    const t = target(gm.publicId);
    await click(t.querySelector<HTMLButtonElement>('button.send'));
    http.expectNone((r) => r.method === 'POST');
    expect(t.querySelector('.field-error')!.textContent).toContain('ratings.form.overallRequired');
    expect(t.querySelector('.overall [role="radiogroup"]')!.getAttribute('aria-invalid')).toBe(
      'true',
    );

    await click(t.querySelector<HTMLButtonElement>('.overall [data-score="4"]'));
    expect(t.querySelector('.field-error')).toBeNull();
    await click(
      t.querySelector<HTMLButtonElement>('[data-criterion="preparation"] [data-score="5"]'),
    );
    // Критерій можна скинути — тоді його немає в запиті.
    await click(t.querySelector<HTMLButtonElement>('[data-criterion="safety"] [data-score="2"]'));
    await click(t.querySelector<HTMLButtonElement>('[data-criterion="safety"] button.reset'));
    expect(t.querySelector('[data-criterion="safety"] button.reset')).toBeNull();
    const textarea = t.querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.value = '  Чудова гра  ';
    textarea.dispatchEvent(new Event('input'));
    await settle();
    expect(t.textContent).toContain('14 / 2000');

    await click(t.querySelector<HTMLButtonElement>('button.send'));
    const req = postReq();
    expect(req.request.body).toEqual({
      rateeId: gm.publicId,
      overall: 4,
      criteria: { preparation: 5 },
      comment: 'Чудова гра',
    });
    req.flush({ ...gm, state: 'rated' }, { status: 201, statusText: 'Created' });
    await settle();
    expect(target(gm.publicId).querySelector('form')).toBeNull();
    expect(target(gm.publicId).querySelector('.result')!.textContent).toContain(
      'ratings.state.rated',
    );
    expect(el().querySelector('.message')!.textContent).toContain('ratings.page.sent');
    expect(document.activeElement).toBe(target(gm.publicId).querySelector('.result'));
    // Лічильник у шапці перечитується.
    expect(http.match('/api/me/ratings/pending')).toHaveLength(1);
  });

  it('decline asks first ("cannot rate later"), then sends a declined session rating', async () => {
    await open('/games/7/rate?session=9');
    const req = targetsReq();
    expect(req.request.params.get('sessionId')).toBe('9');
    req.flush({
      gameId: 7,
      gameTitle: 'Туман над Дніпром',
      sessionId: 9,
      sessionStartsAt: '2026-11-20T17:00:00.000Z',
      kind: 'session',
      targets: [player],
    });
    await settle();
    http.expectNone('/api/games/7/sessions');
    expect(el().querySelector('.kind')!.textContent).toContain('ratings.page.sessionOf');

    dialogOpen.mockReturnValueOnce({ afterClosed: () => of(false) });
    await click(target(player.publicId).querySelector<HTMLButtonElement>('button.decline'));
    expect(dialogOpen).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: expect.objectContaining({ text: 'ratings.decline.text', params: { name: 'Sam' } }),
      }),
    );
    http.expectNone((r) => r.method === 'POST');

    dialogOpen.mockReturnValueOnce({ afterClosed: () => of(true) });
    await click(target(player.publicId).querySelector<HTMLButtonElement>('button.decline'));
    const post = postReq();
    expect(post.request.body).toEqual({ rateeId: player.publicId, sessionId: 9, declined: true });
    post.flush({ ...player, state: 'declined' }, { status: 201, statusText: 'Created' });
    await settle();
    expect(target(player.publicId).dataset['state']).toBe('declined');
    expect(target(player.publicId).textContent).toContain('ratings.state.declined');
    expect(el().querySelector('.all-done')).not.toBeNull();
  });

  it('409 RATING_EXISTS: shows the reason and refreshes to the actual state', async () => {
    await openFinal([gm]);
    const t = target(gm.publicId);
    await click(t.querySelector<HTMLButtonElement>('.overall [data-score="5"]'));
    await click(t.querySelector<HTMLButtonElement>('button.send'));
    postReq().flush({ error: { code: 'RATING_EXISTS' } }, { status: 409, statusText: 'Conflict' });
    await settle();
    targetsReq().flush(finalSet([{ ...gm, state: 'rated' }]));
    await settle();
    expect(el().querySelector('.message')!.textContent).toContain('errors.RATING_EXISTS');
    expect(target(gm.publicId).querySelector('form')).toBeNull();
    expect(target(gm.publicId).textContent).toContain('ratings.state.rated');
  });

  it('window closed: the reason and the empty state after refresh', async () => {
    await openFinal([gm]);
    const t = target(gm.publicId);
    await click(t.querySelector<HTMLButtonElement>('.overall [data-score="3"]'));
    await click(t.querySelector<HTMLButtonElement>('button.send'));
    postReq().flush(
      { error: { code: 'RATING_WINDOW_CLOSED' } },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();
    targetsReq().flush(finalSet([]));
    await settle();
    expect(el().querySelector('.message')!.textContent).toContain('errors.RATING_WINDOW_CLOSED');
    expect(el().querySelector('.empty')!.textContent).toContain('ratings.page.empty');
  });

  it('other errors stay inside the form; the form keeps the choice', async () => {
    await openFinal([gm]);
    const t = target(gm.publicId);
    await click(t.querySelector<HTMLButtonElement>('.overall [data-score="3"]'));
    await click(t.querySelector<HTMLButtonElement>('button.send'));
    postReq().flush(
      { error: { code: 'RATING_CRITERIA_INVALID' } },
      { status: 400, statusText: 'Bad Request' },
    );
    await settle();
    expect(t.querySelector('.nri-alert')!.textContent).toContain('errors.RATING_CRITERIA_INVALID');
    expect(t.querySelector('[data-score="3"]')!.getAttribute('aria-checked')).toBe('true');
    // Кнопка була вимкнена на час запиту — фокус повертається на «Надіслати».
    expect(document.activeElement).toBe(t.querySelector('button.send'));
  });

  it('stale submit whose re-read is 403 (access gone) shows the forbidden state', async () => {
    await openFinal([gm]);
    const t = target(gm.publicId);
    await click(t.querySelector<HTMLButtonElement>('.overall [data-score="3"]'));
    await click(t.querySelector<HTMLButtonElement>('button.send'));
    postReq().flush(
      { error: { code: 'RATING_NOT_ALLOWED' } },
      { status: 403, statusText: 'Forbidden' },
    );
    await settle();
    targetsReq().flush(
      { error: { code: 'RATING_NOT_ALLOWED' } },
      { status: 403, statusText: 'Forbidden' },
    );
    await settle();
    expect(el().querySelector('.forbidden')).not.toBeNull();
    expect(el().querySelector('[data-target]')).toBeNull();
  });

  it('the live message region has no nested alert role (single announcement)', async () => {
    await openFinal([gm]);
    const t = target(gm.publicId);
    await click(t.querySelector<HTMLButtonElement>('.overall [data-score="5"]'));
    await click(t.querySelector<HTMLButtonElement>('button.send'));
    postReq().flush({ error: { code: 'RATING_EXISTS' } }, { status: 409, statusText: 'Conflict' });
    await settle();
    targetsReq().flush(finalSet([{ ...gm, state: 'rated' }]));
    await settle();
    expect(el().querySelector('[aria-live="polite"] [role="alert"]')).toBeNull();
    expect(el().querySelector('[aria-live="polite"] .message')).not.toBeNull();
  });

  it('nothing to rate: empty state with a link to all pending ratings', async () => {
    await openFinal([]);
    expect(el().querySelector('.empty')!.textContent).toContain('ratings.page.empty');
    expect(el().querySelector('.empty a')!.getAttribute('href')).toBe('/ratings');
  });

  it('not a participant (403): explains who can rate', async () => {
    await open('/games/7/rate');
    targetsReq().flush(
      { error: { code: 'RATING_NOT_ALLOWED' } },
      { status: 403, statusText: 'Forbidden' },
    );
    await settle();
    expect(el().querySelector('.forbidden')!.textContent).toContain('errors.RATING_NOT_ALLOWED');
  });

  it('a malformed ?session= is "not found" without requests', async () => {
    await open('/games/7/rate?session=abc');
    http.expectNone((r) => r.url.startsWith('/api/games/7'));
    expect(el().querySelector('.not-found')).not.toBeNull();
  });
});
