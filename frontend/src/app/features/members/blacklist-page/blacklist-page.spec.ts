import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import type { BlacklistEntryDto } from '@nri/shared';
import { BlacklistPage } from './blacklist-page';

const entries: BlacklistEntryDto[] = [
  {
    publicId: 'aaaaaaaaaa',
    nickname: 'Gollum',
    avatarUrl: null,
    createdAt: '2026-11-20T10:00:00.000Z',
  },
  {
    publicId: 'bbbbbbbbbb',
    nickname: null,
    avatarUrl: null,
    createdAt: '2026-11-19T10:00:00.000Z',
  },
];

describe('BlacklistPage', () => {
  let fixture: ComponentFixture<BlacklistPage>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let dialogOpen: ReturnType<typeof vi.fn>;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create(list: BlacklistEntryDto[] = entries) {
    dialogOpen = vi.fn();
    await TestBed.configureTestingModule({
      imports: [BlacklistPage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
        { provide: MatDialog, useValue: { open: dialogOpen } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(BlacklistPage);
    el = fixture.nativeElement as HTMLElement;
    await settle();
    http.expectOne('/api/me/blacklist').flush(list);
    await settle();
  }

  afterEach(() => http.verify());

  const row = (id: string) => el.querySelector<HTMLElement>(`[data-user-id="${id}"]`);

  it('lists blacklisted users; a deleted account shows as deleted', async () => {
    await create();
    expect(row('aaaaaaaaaa')!.querySelector('a')!.getAttribute('href')).toBe('/users/aaaaaaaaaa');
    expect(row('bbbbbbbbbb')!.textContent).toContain('user.deleted');
  });

  it('unban: asks first, then DELETEs and removes the row with a live notice', async () => {
    await create();
    dialogOpen.mockReturnValueOnce({ afterClosed: () => of(false) });
    row('aaaaaaaaaa')!.querySelector<HTMLButtonElement>('button.unban')!.click();
    await settle();
    http.expectNone('/api/me/blacklist/aaaaaaaaaa');

    dialogOpen.mockReturnValueOnce({ afterClosed: () => of(true) });
    row('aaaaaaaaaa')!.querySelector<HTMLButtonElement>('button.unban')!.click();
    await settle();
    const req = http.expectOne('/api/me/blacklist/aaaaaaaaaa');
    expect(req.request.method).toBe('DELETE');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    expect(row('aaaaaaaaaa')).toBeNull();
    expect(el.querySelector('[aria-live="polite"]')!.textContent).toContain(
      'members.blacklist.removed',
    );
  });

  it('empty list explains what the blacklist does', async () => {
    await create([]);
    expect(el.textContent).toContain('members.blacklist.empty');
  });

  it('after unban focus moves to the next row, then to the heading', async () => {
    await create();
    dialogOpen.mockReturnValue({ afterClosed: () => of(true) });
    row('aaaaaaaaaa')!.querySelector<HTMLButtonElement>('button.unban')!.click();
    await settle();
    http
      .expectOne('/api/me/blacklist/aaaaaaaaaa')
      .flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    expect(document.activeElement).toBe(
      row('bbbbbbbbbb')!.querySelector<HTMLButtonElement>('button.unban'),
    );

    row('bbbbbbbbbb')!.querySelector<HTMLButtonElement>('button.unban')!.click();
    await settle();
    // Видалений акаунт у підтвердженні — «Видалений користувач».
    expect(dialogOpen).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: expect.objectContaining({ params: { name: 'user.deleted' } }),
      }),
    );
    http
      .expectOne('/api/me/blacklist/bbbbbbbbbb')
      .flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    expect(document.activeElement).toBe(el.querySelector('h1'));
  });
});
