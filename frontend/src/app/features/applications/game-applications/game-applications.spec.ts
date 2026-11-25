import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import type { GameApplicationDto, GameDto, MemberDto } from '@nri/shared';
import { GameApplications } from './game-applications';
import { ConfirmDialog } from '../../../shared/confirm-dialog/confirm-dialog';

const game: GameDto = {
  id: 7,
  title: 'Туман над Дніпром',
  description: '',
  system: { id: 1, name: 'D&D 5e' },
  systemOther: null,
  genreId: 1,
  gm: { publicId: 'zzzzzzzzzz', nickname: 'Gandalf', avatarUrl: null },
  format: 'online',
  city: null,
  platform: null,
  address: null,
  channelLinks: [],
  kind: 'campaign',
  startsAt: '2027-03-02T17:00:00.000Z',
  durationMinutes: 240,
  recurrence: 'weekly',
  weekdays: [1],
  minPlayers: 1,
  maxPlayers: 2,
  priceUah: null,
  ageRating: 'none',
  experience: 'beginner',
  language: 'uk',
  requirements: null,
  coverUrl: null,
  applicationQuestions: ['Досвід?', 'Персонаж?'],
  customWarnings: [],
  contentWarningIds: [],
  showWhenFull: false,
  timezone: 'Europe/Kyiv',
  status: 'recruiting',
  nextSessionAt: null,
  freeSlots: 1,
  publishedAt: '2026-11-01T10:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  cancelledAt: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
};

const pending: GameApplicationDto = {
  id: 11,
  gameId: 7,
  status: 'pending',
  message: 'Привіт, майстре',
  answers: ['Багато', 'Ельф'],
  constraints: [
    { id: 'aaaaaaaa', text: 'Без павуків', response: null, comment: null },
    { id: 'bbbbbbbb', text: 'До 22:00', response: 'accepted', comment: null },
  ],
  cancelReason: null,
  createdAt: '2026-11-20T10:00:00.000Z',
  decidedAt: null,
  applicant: { publicId: 'pppppppppp', nickname: 'Frodo', avatarUrl: null },
  meetsAgeRating: true,
};

const rejected: GameApplicationDto = {
  ...pending,
  id: 12,
  status: 'rejected',
  constraints: [],
  applicant: { publicId: 'qqqqqqqqqq', nickname: 'Sam', avatarUrl: null },
  decidedAt: '2026-11-21T10:00:00.000Z',
};

const member = (publicId: string): MemberDto => ({
  publicId,
  nickname: publicId,
  avatarUrl: null,
  joinedAt: '2026-11-10T10:00:00.000Z',
});

describe('GameApplications', () => {
  let fixture: ComponentFixture<GameApplications>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let dialogOpen: ReturnType<typeof vi.fn>;
  const nextDialog = (result: unknown) =>
    dialogOpen.mockReturnValueOnce({ afterClosed: () => of(result) });

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create(members: MemberDto[] = [member('m1')]) {
    dialogOpen = vi.fn();
    await TestBed.configureTestingModule({
      imports: [GameApplications],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
        { provide: MatDialog, useValue: { open: dialogOpen } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GameApplications);
    fixture.componentRef.setInput('id', '7');
    el = fixture.nativeElement as HTMLElement;
    await settle();
    http.expectOne('/api/games/7').flush(game);
    http.expectOne('/api/games/7/applications').flush([rejected, pending]);
    http.expectOne('/api/games/7/members').flush(members);
    await settle();
    await settle();
  }

  afterEach(() => http.verify());

  const card = (id: number) => el.querySelector<HTMLElement>(`[data-application-id="${id}"]`)!;
  const constraint = (cid: string) =>
    card(11).querySelector<HTMLElement>(`[data-constraint-id="${cid}"]`)!;
  const pick = async (cid: string, response: string) => {
    constraint(cid)
      .querySelector<HTMLInputElement>(`input[type="radio"][value="${response}"]`)!
      .click();
    await settle();
  };
  const typeComment = async (cid: string, text: string) => {
    const area = constraint(cid).querySelector<HTMLTextAreaElement>('textarea')!;
    area.value = text;
    area.dispatchEvent(new Event('input'));
    await settle();
  };
  const save = async (cid: string) => {
    constraint(cid).querySelector<HTMLButtonElement>('button.save-constraint')!.click();
    await settle();
  };

  it('shows pending first with answers paired with questions, message and constraints', async () => {
    await create();
    const ids = [...el.querySelectorAll('[data-application-id]')].map((n) =>
      n.getAttribute('data-application-id'),
    );
    expect(ids).toEqual(['11', '12']);
    const text = card(11).textContent!;
    expect(text).toContain('Frodo');
    expect(text).toContain('Досвід?');
    expect(text).toContain('Багато');
    expect(text).toContain('Персонаж?');
    expect(text).toContain('Ельф');
    expect(text).toContain('Привіт, майстре');
    expect(text).toContain('Без павуків');
    // Закриті заявки — без дій і редагування обмежень.
    expect(card(12).querySelector('button.approve')).toBeNull();
    expect(card(12).querySelector('.save-constraint')).toBeNull();
  });

  it('partial without a comment blocks saving; with a comment PUTs the response', async () => {
    await create();
    await pick('aaaaaaaa', 'partial');
    await save('aaaaaaaa');
    http.expectNone('/api/applications/11/constraints/aaaaaaaa');
    const area = constraint('aaaaaaaa').querySelector<HTMLTextAreaElement>('textarea')!;
    expect(area.getAttribute('aria-invalid')).toBe('true');
    expect(constraint('aaaaaaaa').textContent).toContain('games.applications.gm.commentRequired');
    expect(document.activeElement).toBe(area);

    await typeComment('aaaaaaaa', 'Лише згадки');
    await save('aaaaaaaa');
    const req = http.expectOne('/api/applications/11/constraints/aaaaaaaa');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ response: 'partial', comment: 'Лише згадки' });
    req.flush({
      ...pending,
      constraints: [
        { id: 'aaaaaaaa', text: 'Без павуків', response: 'partial', comment: 'Лише згадки' },
        pending.constraints[1],
      ],
    });
    await settle();
    expect(el.textContent).toContain('games.applications.gm.responseSaved');
  });

  it('approve within the limit POSTs right away and moves the card to approved', async () => {
    await create();
    card(11).querySelector<HTMLButtonElement>('button.approve')!.click();
    await settle();
    expect(dialogOpen).not.toHaveBeenCalled();
    http
      .expectOne('/api/applications/11/approve')
      .flush({ ...pending, status: 'approved', decidedAt: '2026-11-25T10:00:00.000Z' });
    await settle();
    expect(card(11).closest('section')!.getAttribute('data-status')).toBe('approved');
    // Обмеження затвердженої заявки ще можна редагувати.
    expect(card(11).querySelector('.save-constraint')).not.toBeNull();
  });

  it('approving beyond the maximum shows a warning and asks first', async () => {
    await create([member('m1'), member('m2')]);
    expect(el.querySelector('.full-warning')).not.toBeNull();
    nextDialog(false);
    card(11).querySelector<HTMLButtonElement>('button.approve')!.click();
    await settle();
    expect(dialogOpen).toHaveBeenCalledWith(
      ConfirmDialog,
      expect.objectContaining({
        data: expect.objectContaining({
          title: 'games.applications.gm.confirmOverMax.title',
          params: { count: 2, max: 2 },
        }),
      }),
    );
    http.expectNone('/api/applications/11/approve');

    nextDialog(true);
    card(11).querySelector<HTMLButtonElement>('button.approve')!.click();
    await settle();
    http.expectOne('/api/applications/11/approve').flush({ ...pending, status: 'approved' });
    await settle();
  });

  it('reject asks for confirmation, then POSTs', async () => {
    await create();
    nextDialog(false);
    card(11).querySelector<HTMLButtonElement>('button.reject')!.click();
    await settle();
    http.expectNone('/api/applications/11/reject');
    nextDialog(true);
    card(11).querySelector<HTMLButtonElement>('button.reject')!.click();
    await settle();
    http.expectOne('/api/applications/11/reject').flush({ ...pending, status: 'rejected' });
    await settle();
    expect(card(11).closest('section')!.getAttribute('data-status')).toBe('rejected');
    expect(el.textContent).toContain('games.applications.gm.rejected');
  });

  it('after a decision focus moves to the next pending card, else to the message', async () => {
    dialogOpen = vi.fn();
    const second: GameApplicationDto = {
      ...pending,
      id: 13,
      constraints: [],
      createdAt: '2026-11-21T10:00:00.000Z',
      applicant: { publicId: 'rrrrrrrrrr', nickname: 'Pippin', avatarUrl: null },
    };
    await TestBed.configureTestingModule({
      imports: [GameApplications],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
        { provide: MatDialog, useValue: { open: dialogOpen } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GameApplications);
    fixture.componentRef.setInput('id', '7');
    el = fixture.nativeElement as HTMLElement;
    await settle();
    http.expectOne('/api/games/7').flush(game);
    http.expectOne('/api/games/7/applications').flush([pending, second]);
    http.expectOne('/api/games/7/members').flush([]);
    await settle();
    await settle();

    card(11).querySelector<HTMLButtonElement>('button.approve')!.click();
    await settle();
    http.expectOne('/api/applications/11/approve').flush({ ...pending, status: 'approved' });
    await settle();
    expect(document.activeElement).toBe(card(13));

    nextDialog(true);
    card(13).querySelector<HTMLButtonElement>('button.reject')!.click();
    await settle();
    http.expectOne('/api/applications/13/reject').flush({ ...second, status: 'rejected' });
    await settle();
    expect(document.activeElement).toBe(el.querySelector('.message-area'));
  });

  it('approving with unsaved constraint responses warns in the confirmation', async () => {
    await create();
    await pick('aaaaaaaa', 'cannot_guarantee');
    nextDialog(false);
    card(11).querySelector<HTMLButtonElement>('button.approve')!.click();
    await settle();
    expect(dialogOpen).toHaveBeenCalledWith(
      ConfirmDialog,
      expect.objectContaining({
        data: expect.objectContaining({ title: 'games.applications.gm.confirmUnsaved.title' }),
      }),
    );
    http.expectNone('/api/applications/11/approve');
  });

  it('over the maximum with unsaved responses: one confirmation with an extra warning', async () => {
    await create([member('m1'), member('m2')]);
    await pick('aaaaaaaa', 'cannot_guarantee');
    nextDialog(false);
    card(11).querySelector<HTMLButtonElement>('button.approve')!.click();
    await settle();
    expect(dialogOpen).toHaveBeenCalledTimes(1);
    expect(dialogOpen).toHaveBeenCalledWith(
      ConfirmDialog,
      expect.objectContaining({
        data: expect.objectContaining({
          title: 'games.applications.gm.confirmOverMax.title',
          note: 'games.applications.gm.unsavedNote',
        }),
      }),
    );
  });

  it('the reject confirmation names a deleted applicant «deleted user»', async () => {
    await create();
    fixture.componentInstance['items'].update((list) =>
      (list ?? []).map((a) => ({ ...a, applicant: { ...a.applicant, nickname: null } })),
    );
    await settle();
    nextDialog(false);
    card(11).querySelector<HTMLButtonElement>('button.reject')!.click();
    await settle();
    expect(dialogOpen).toHaveBeenCalledWith(
      ConfirmDialog,
      expect.objectContaining({
        data: expect.objectContaining({ params: { name: 'user.deleted' } }),
      }),
    );
  });
});
