import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import type { MemberDto } from '@nri/shared';
import { MembersPanel } from './members-panel';
import { ConfirmDialog } from '../../../shared/confirm-dialog/confirm-dialog';

const members: MemberDto[] = [
  {
    publicId: 'aaaaaaaaaa',
    nickname: 'Frodo',
    avatarUrl: null,
    joinedAt: '2026-11-10T10:00:00.000Z',
  },
  {
    publicId: 'bbbbbbbbbb',
    nickname: 'Sam',
    avatarUrl: null,
    joinedAt: '2026-11-11T10:00:00.000Z',
  },
];

describe('MembersPanel', () => {
  let fixture: ComponentFixture<MembersPanel>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let dialogOpen: ReturnType<typeof vi.fn>;
  let changed: ReturnType<typeof vi.fn<() => void>>;
  const nextDialog = (result: unknown) =>
    dialogOpen.mockReturnValueOnce({ afterClosed: () => of(result) });

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create(isGm: boolean, manageable = true) {
    dialogOpen = vi.fn();
    changed = vi.fn<() => void>();
    await TestBed.configureTestingModule({
      imports: [MembersPanel],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
        { provide: MatDialog, useValue: { open: dialogOpen } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(MembersPanel);
    fixture.componentRef.setInput('gameId', 3);
    fixture.componentRef.setInput('isGm', isGm);
    fixture.componentRef.setInput('manageable', manageable);
    fixture.componentInstance.changed.subscribe(() => changed());
    el = fixture.nativeElement as HTMLElement;
    await settle();
    http.expectOne('/api/games/3/members').flush(members);
    await settle();
  }

  afterEach(() => http.verify());

  const row = (publicId: string) => el.querySelector<HTMLElement>(`[data-member-id="${publicId}"]`);
  /** Дія з меню учасника (пункти меню — кнопки з `data-action`). */
  const action = async (publicId: string, name: string) => {
    row(publicId)!.querySelector<HTMLButtonElement>('button.member-menu')!.click();
    await settle();
    document
      .querySelector<HTMLButtonElement>(`.mat-mdc-menu-panel button[data-action="${name}"]`)!
      .click();
    await settle();
  };

  it('lists members with profile links; a player sees no management menu', async () => {
    await create(false);
    expect(row('aaaaaaaaaa')!.querySelector('a')!.getAttribute('href')).toBe('/users/aaaaaaaaaa');
    expect(row('bbbbbbbbbb')!.textContent).toContain('Sam');
    expect(el.querySelector('button.member-menu')).toBeNull();
  });

  it('ban: asks first, then calls the ban endpoint and removes the member', async () => {
    await create(true);
    nextDialog(false);
    await action('aaaaaaaaaa', 'ban');
    expect(dialogOpen).toHaveBeenCalledWith(
      ConfirmDialog,
      expect.objectContaining({
        data: expect.objectContaining({ title: 'members.confirm.ban.title', danger: true }),
      }),
    );
    http.expectNone('/api/games/3/members/aaaaaaaaaa/ban');

    nextDialog(true);
    await action('aaaaaaaaaa', 'ban');
    const req = http.expectOne('/api/games/3/members/aaaaaaaaaa/ban');
    expect(req.request.method).toBe('POST');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    expect(row('aaaaaaaaaa')).toBeNull();
    expect(row('bbbbbbbbbb')).not.toBeNull();
    expect(el.textContent).toContain('members.done.ban');
    expect(changed).toHaveBeenCalled();
  });

  it('kick calls the kick endpoint and removes the member', async () => {
    await create(true);
    nextDialog(true);
    await action('bbbbbbbbbb', 'kick');
    http
      .expectOne('/api/games/3/members/bbbbbbbbbb/kick')
      .flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    expect(row('bbbbbbbbbb')).toBeNull();
  });

  it('blacklist adds to my blacklist and keeps the member in the game', async () => {
    await create(true);
    nextDialog(true);
    await action('aaaaaaaaaa', 'blacklist');
    const req = http.expectOne('/api/me/blacklist/aaaaaaaaaa');
    expect(req.request.method).toBe('POST');
    req.flush({ ...members[0], createdAt: '2026-11-25T10:00:00.000Z' });
    await settle();
    expect(row('aaaaaaaaaa')).not.toBeNull();
    expect(el.textContent).toContain('members.done.blacklist');
    expect(changed).not.toHaveBeenCalled();
  });

  it('a finished game offers only the blacklist', async () => {
    await create(true, false);
    row('aaaaaaaaaa')!.querySelector<HTMLButtonElement>('button.member-menu')!.click();
    await settle();
    const names = [
      ...document.querySelectorAll<HTMLButtonElement>('.mat-mdc-menu-panel button[data-action]'),
    ].map((b) => b.dataset['action']);
    expect(names).toEqual(['blacklist']);
  });
});
