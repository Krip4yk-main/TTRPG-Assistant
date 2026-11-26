import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MatDialog } from '@angular/material/dialog';
import { Router, provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import type { MeDto } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { ScheduleRuleDialog } from '../../sessions/schedule-rule-dialog/schedule-rule-dialog';
import { CommonTimesDialog } from '../common-times-dialog/common-times-dialog';
import { PollCreateDialog } from '../poll-create-dialog/poll-create-dialog';
import { poll, session } from '../scheduling-testing';
import { SessionAlternativesDialog } from '../session-alternatives-dialog/session-alternatives-dialog';
import { PollsPanel, type PollsPanelGame } from './polls-panel';

const game: PollsPanelGame = {
  id: 7,
  kind: 'campaign',
  status: 'started',
  timezone: 'Europe/Kyiv',
  startsAt: '2030-03-01T17:00:00.000Z',
  nextSessionAt: '2030-03-07T17:00:00.000Z',
  durationMinutes: 240,
  recurrence: 'weekly',
  weekdays: [3],
};

const flushAsync = () => new Promise((r) => setTimeout(r, 0));

describe('PollsPanel', () => {
  let fixture: ComponentFixture<PollsPanel>;
  let http: HttpTestingController;
  let el: HTMLElement;
  /** Відповіді діалогів за компонентом. */
  let results: Map<unknown, unknown>;
  let opened: { component: unknown; data: unknown }[];
  let changed: number;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function open(
    isGm: boolean,
    inputs: Record<string, unknown> = {},
    preset: [unknown, unknown][] = [],
  ) {
    results = new Map(preset);
    opened = [];
    await TestBed.configureTestingModule({
      imports: [PollsPanel],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        provideRouter([]),
        {
          provide: MatDialog,
          useValue: {
            open: (component: unknown, config: { data: unknown }) => {
              opened.push({ component, data: config.data });
              return { afterClosed: () => of(results.get(component)) };
            },
          },
        },
      ],
    }).compileComponents();
    TestBed.inject(AuthStore).setMe({ id: isGm ? 1 : 2, timezone: 'Europe/Kyiv' } as MeDto);
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PollsPanel);
    fixture.componentRef.setInput('game', game);
    fixture.componentRef.setInput('isGm', isGm);
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    changed = 0;
    fixture.componentInstance.changed.subscribe(() => changed++);
    el = fixture.nativeElement as HTMLElement;
    await settle();
  }

  afterEach(() => http.verify());

  it('a member without polls sees nothing; with a poll — the card', async () => {
    await open(false);
    http.expectOne('/api/games/7/polls').flush([]);
    await settle();
    expect(el.querySelector('.polls-panel')).toBeNull();
    fixture.componentInstance.reload();
    http.expectOne('/api/games/7/polls').flush([poll()]);
    await flushAsync();
    await settle();
    expect(el.querySelectorAll('nri-poll-card').length).toBe(1);
    expect(el.querySelector('button.find-times')).toBeNull();
    expect(el.querySelector('button.new-poll')).toBeNull();
  });

  it('GM: finder → «create poll» opens the create dialog with the picked options', async () => {
    await open(true);
    http.expectOne('/api/games/7/polls').flush([]);
    await settle();
    expect(el.textContent).toContain('scheduling.panel.empty');
    const options = [
      { startsAt: '2030-03-08T17:00:00.000Z' },
      { startsAt: '2030-03-09T16:00:00.000Z' },
    ];
    results.set(CommonTimesDialog, { kind: 'poll', pollKind: 'one_off', options });
    const created = poll({ id: 9, kind: 'one_off', isGm: true, canVote: false });
    results.set(PollCreateDialog, created);
    el.querySelector<HTMLButtonElement>('button.find-times')!.click();
    await flushAsync();
    await settle();
    expect(opened.map((o) => o.component)).toEqual([CommonTimesDialog, PollCreateDialog]);
    expect(opened[1]!.data).toMatchObject({ gameId: 7, prefill: { pollKind: 'one_off', options } });
    expect(el.querySelector('[data-poll-id="9"]')).not.toBeNull();
    expect(el.textContent).toContain('scheduling.panel.created');
  });

  it('GM: finder → «apply as schedule» opens the existing schedule dialog prefilled', async () => {
    await open(true);
    http.expectOne('/api/games/7/polls').flush([]);
    await settle();
    results.set(CommonTimesDialog, {
      kind: 'schedule',
      startsAt: '2030-03-01T17:00:00.000Z',
      weekday: 4,
    });
    results.set(ScheduleRuleDialog, { id: 7 });
    el.querySelector<HTMLButtonElement>('button.find-times')!.click();
    await flushAsync();
    await settle();
    expect(opened[1]!.component).toBe(ScheduleRuleDialog);
    expect(opened[1]!.data).toMatchObject({
      mode: 'schedule',
      prefill: { startsAt: '2030-03-01T17:00:00.000Z', weekdays: [4] },
    });
    expect(changed).toBe(1);
  });

  it('?session= opens the alternatives for the GM and clears the parameter', async () => {
    await open(true, { sessionId: '41' }, [
      [SessionAlternativesDialog, session({ rescheduled: true })],
    ]);
    http.expectOne('/api/games/7/polls').flush([]);
    // Діалог вантажиться окремим чанком — чекаємо, поки його відкриють і закриють.
    await vi.waitFor(() => expect(changed).toBe(1));
    await settle();
    expect(opened.find((o) => o.component === SessionAlternativesDialog)?.data).toEqual({
      sessionId: 41,
      viewerTimezone: 'Europe/Kyiv',
    });
    expect(TestBed.inject(Router).navigate).toHaveBeenCalledWith([], {
      queryParams: { session: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    expect(changed).toBe(1);
  });

  it('?session= is ignored for a member', async () => {
    await open(false, { sessionId: '41' });
    http.expectOne('/api/games/7/polls').flush([poll()]);
    await flushAsync();
    await settle();
    expect(opened.length).toBe(0);
  });

  it('?poll= focuses the poll; old closed polls are revealed; unknown → notice', async () => {
    const closed = [1, 2, 3, 4].map((i) => poll({ id: 100 + i, status: 'closed', canVote: false }));
    await open(false, { pollId: '104' });
    http.expectOne('/api/games/7/polls').flush([poll(), ...closed]);
    await settle();
    await flushAsync();
    expect(el.querySelector('[data-poll-id="104"]')).not.toBeNull();
    expect(document.activeElement?.closest('[data-poll-id="104"]')).not.toBeNull();
    fixture.componentRef.setInput('pollId', '999');
    await settle();
    expect(el.textContent).toContain('scheduling.panel.pollMissing');
  });

  it('a member without polls still sees the «poll is gone» notice', async () => {
    await open(false, { pollId: '77' });
    http.expectOne('/api/games/7/polls').flush([]);
    await settle();
    expect(el.querySelector('.polls-panel')).not.toBeNull();
    expect(el.textContent).toContain('scheduling.panel.pollMissing');
  });

  it('a reloaded game object (same id) does not refetch polls; finished games hide the finder', async () => {
    await open(true);
    http.expectOne('/api/games/7/polls').flush([]);
    await settle();
    expect(el.querySelector('button.find-times')).not.toBeNull();
    fixture.componentRef.setInput('game', { ...game, status: 'finished' });
    await settle();
    http.expectNone('/api/games/7/polls');
    expect(el.querySelector('button.find-times')).toBeNull();
    expect(el.querySelector('button.new-poll')).toBeNull();
  });

  it('only 3 closed polls by default, the rest behind a toggle', async () => {
    const closed = [1, 2, 3, 4].map((i) => poll({ id: 100 + i, status: 'closed', canVote: false }));
    await open(false);
    http.expectOne('/api/games/7/polls').flush(closed);
    await settle();
    expect(el.querySelectorAll('nri-poll-card').length).toBe(3);
    el.querySelector<HTMLButtonElement>('button.toggle-closed')!.click();
    await settle();
    expect(el.querySelectorAll('nri-poll-card').length).toBe(4);
  });

  it('reload (live update) failure reports false and shows the error', async () => {
    await open(true);
    http.expectOne('/api/games/7/polls').flush([]);
    await settle();
    const done = fixture.componentInstance.reload(true);
    http
      .expectOne('/api/games/7/polls')
      .flush({ error: { code: 'INTERNAL' } }, { status: 500, statusText: 'x' });
    expect(await done).toBe(false);
    await settle();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('errors.INTERNAL');
  });
});
