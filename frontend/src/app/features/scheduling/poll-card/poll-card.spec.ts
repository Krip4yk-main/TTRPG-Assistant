import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import type { MeDto, PollDto } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { poll } from '../scheduling-testing';
import { PollCard } from './poll-card';

describe('PollCard', () => {
  let fixture: ComponentFixture<PollCard>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let confirm: boolean;
  let changed: PollDto[];
  let applied: unknown[];

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function open(p: PollDto, meId = 2, paused = false) {
    confirm = true;
    await TestBed.configureTestingModule({
      imports: [PollCard],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: MatDialog, useValue: { open: () => ({ afterClosed: () => of(confirm) }) } },
      ],
    }).compileComponents();
    TestBed.inject(AuthStore).setMe({ id: meId, timezone: 'Europe/Kyiv' } as MeDto);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PollCard);
    fixture.componentRef.setInput('poll', p);
    fixture.componentRef.setInput('viewerTimezone', 'Europe/Kyiv');
    fixture.componentRef.setInput('gameKind', 'campaign');
    fixture.componentRef.setInput('paused', paused);
    changed = [];
    applied = [];
    fixture.componentInstance.changed.subscribe((d) => {
      changed.push(d);
      fixture.componentRef.setInput('poll', d);
    });
    fixture.componentInstance.applied.subscribe((r) => applied.push(r));
    el = fixture.nativeElement as HTMLElement;
    await settle();
  }

  afterEach(() => http.verify());

  const option = (id: number) => el.querySelector<HTMLElement>(`[data-option-id="${id}"]`)!;
  const voteBtn = (id: number, value: string) =>
    option(id).querySelector<HTMLButtonElement>(`button.vote-btn[data-value="${value}"]`)!;

  it('member: own answers are pressed; changing one sends only that option', async () => {
    await open(poll());
    expect(voteBtn(51, 'yes').getAttribute('aria-pressed')).toBe('true');
    expect(voteBtn(52, 'no').getAttribute('aria-pressed')).toBe('true');
    expect(option(51).querySelector('.vote')!.getAttribute('role')).toBe('group');
    // Регулярний варіант — «щотижня: день, час» у поясі глядача.
    expect(option(51).textContent).toContain('scheduling.weekly');
    voteBtn(52, 'maybe').click();
    await settle();
    const req = http.expectOne('/api/polls/5/votes');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ votes: [{ optionId: 52, value: 'maybe' }] });
    const next = poll();
    next.options[1]!.votes = [{ userId: 2, value: 'maybe' }];
    req.flush(next);
    await settle();
    expect(changed.length).toBe(1);
    expect(voteBtn(52, 'maybe').getAttribute('aria-pressed')).toBe('true');
    expect(el.textContent).toContain('scheduling.poll.voted');
  });

  it('voting after the deadline: POLL_CLOSED is shown', async () => {
    await open(poll());
    voteBtn(52, 'yes').click();
    http
      .expectOne('/api/polls/5/votes')
      .flush({ error: { code: 'POLL_CLOSED' } }, { status: 409, statusText: 'x' });
    await settle();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('errors.POLL_CLOSED');
  });

  it('GM sees tallies and answers, no vote buttons, can close early after confirm', async () => {
    await open(poll({ isGm: true, canVote: false }), 1);
    expect(el.querySelector('button.vote-btn')).toBeNull();
    expect(el.textContent).toContain('scheduling.poll.tally');
    expect(option(51).querySelector('details.answers')).not.toBeNull();
    confirm = false;
    el.querySelector<HTMLButtonElement>('button.close')!.click();
    await settle();
    http.expectNone('/api/polls/5/close');
    confirm = true;
    el.querySelector<HTMLButtonElement>('button.close')!.click();
    await settle();
    http
      .expectOne('/api/polls/5/close')
      .flush(poll({ isGm: true, canVote: false, status: 'closed', closeReason: 'gm' }));
    await settle();
    expect(el.querySelector('.state')!.textContent).toContain('scheduling.poll.reason.gm');
    expect(option(51).classList).toContain('winner');
  });

  it('apply: multi-weekday confirm → «add» sends current days plus the option day', async () => {
    const closed = poll({ isGm: true, canVote: false, status: 'closed', closeReason: 'deadline' });
    await open(closed, 1);
    el.querySelector<HTMLButtonElement>('button.apply-winner')!.click();
    await settle();
    const first = http.expectOne('/api/polls/5/apply');
    expect(first.request.body).toEqual({ optionId: 51 });
    first.flush(
      { error: { code: 'POLL_APPLY_CONFIRM', details: { currentWeekdays: [1, 5] } } },
      { status: 409, statusText: 'x' },
    );
    await settle();
    const pending = el.querySelector<HTMLElement>('.pending')!;
    expect(pending.textContent).toContain('scheduling.poll.weekdays.timeNote');
    // Питання озвучується й отримує фокус: обраний варіант «замінити».
    expect(pending.querySelector('[role="status"]')!.textContent).toContain(
      'scheduling.poll.weekdays.title',
    );
    expect(document.activeElement).toBe(pending.querySelector('input[value="replace"]'));
    pending.querySelector<HTMLInputElement>('input[value="add"]')!.click();
    await settle();
    el.querySelector<HTMLButtonElement>('button.confirm-pending')!.click();
    await settle();
    const second = http.expectOne('/api/polls/5/apply');
    expect(second.request.body).toEqual({ optionId: 51, weekdays: [1, 4, 5] });
    second.flush({
      poll: { ...closed, appliedAt: '2030-03-03T11:00:00.000Z', appliedOptionId: 51 },
      applied: { kind: 'schedule' },
    });
    await settle();
    expect(applied.length).toBe(1);
    expect(el.querySelector('.pending')).toBeNull();
    expect(el.querySelector('.state')!.textContent).toContain('scheduling.poll.state.applied');
    expect(el.querySelector('button.apply-winner')).toBeNull();
  });

  it('apply: replace keeps only the option day', async () => {
    await open(poll({ isGm: true, canVote: false, status: 'closed' }), 1);
    el.querySelector<HTMLButtonElement>('button.apply-winner')!.click();
    http
      .expectOne('/api/polls/5/apply')
      .flush(
        { error: { code: 'POLL_APPLY_CONFIRM', details: { currentWeekdays: [1, 5] } } },
        { status: 409, statusText: 'x' },
      );
    await settle();
    el.querySelector<HTMLButtonElement>('button.confirm-pending')!.click();
    expect(http.expectOne('/api/polls/5/apply').request.body).toEqual({
      optionId: 51,
      weekdays: [4],
    });
  });

  it('apply: target session gone → offer «create as a new session»', async () => {
    const p = poll({
      kind: 'one_off',
      sessionId: 41,
      isGm: true,
      canVote: false,
      status: 'closed',
      options: poll().options.map((o) => ({ ...o, weekday: null, startMin: null })),
    });
    await open(p, 1);
    el.querySelector<HTMLButtonElement>('button.apply-winner')!.click();
    http
      .expectOne('/api/polls/5/apply')
      .flush({ error: { code: 'SESSION_INVALID_STATE' } }, { status: 409, statusText: 'x' });
    await settle();
    expect(el.querySelector('.pending')!.textContent).toContain('scheduling.poll.newSession.text');
    expect(document.activeElement).toBe(el.querySelector('button.confirm-pending'));
    el.querySelector<HTMLButtonElement>('button.confirm-pending')!.click();
    expect(http.expectOne('/api/polls/5/apply').request.body).toEqual({
      optionId: 51,
      asNewSession: true,
    });
  });

  it('apply errors are mapped (GAME_PAUSED), and another option can be applied', async () => {
    await open(poll({ isGm: true, canVote: false, status: 'closed' }), 1);
    option(52).querySelector<HTMLButtonElement>('button.apply-option')!.click();
    const req = http.expectOne('/api/polls/5/apply');
    expect(req.request.body).toEqual({ optionId: 52 });
    req.flush({ error: { code: 'GAME_PAUSED' } }, { status: 409, statusText: 'x' });
    await settle();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('errors.GAME_PAUSED');
  });

  it('paused campaign / no winner: explanations instead of the apply button', async () => {
    await open(poll({ isGm: true, canVote: false, status: 'closed' }), 1, true);
    expect(el.querySelector('button.apply-winner')).toBeNull();
    expect(el.textContent).toContain('scheduling.poll.pausedHint');
    fixture.componentRef.setInput('paused', false);
    fixture.componentRef.setInput(
      'poll',
      poll({ isGm: true, canVote: false, status: 'closed', winnerOptionId: null }),
    );
    await settle();
    expect(el.textContent).toContain('scheduling.poll.noWinner');
  });
});
