import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import type { AdminUserListItemDto, MeDto } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { AdminRoles } from './roles';

const item = (publicId: string, over: Partial<AdminUserListItemDto>): AdminUserListItemDto => ({
  publicId,
  nickname: publicId,
  avatarUrl: null,
  role: 'user',
  status: 'active',
  isBanned: false,
  hasTelegram: true,
  ...over,
});

type Internals = {
  pick(u: AdminUserListItemDto, r: 'moderator'): void;
  save(u: AdminUserListItemDto): Promise<void>;
};

describe('AdminRoles without Telegram', () => {
  async function render(items: AdminUserListItemDto[], role: MeDto['role'] = 'owner') {
    await TestBed.configureTestingModule({
      imports: [AdminRoles],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
      ],
    }).compileComponents();
    TestBed.inject(AuthStore).setMe({ role } as MeDto);
    const fixture = TestBed.createComponent(AdminRoles);
    const http = TestBed.inject(HttpTestingController);
    const el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
    el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    http.expectOne((r) => r.url === '/api/admin/users').flush({ items, nextCursor: null });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('li.row')).not.toBeNull();
    });
    return { fixture, el, http, cmp: fixture.componentInstance as unknown as Internals };
  }

  const row = (el: HTMLElement, id: string) =>
    el.querySelector<HTMLElement>(`[data-user="${id}"]`)!;

  it('marks staff and candidates without Telegram; people with Telegram get no marker', async () => {
    const { el, http } = await render([
      item('staff00001', { role: 'moderator', hasTelegram: false }),
      item('cand000001', { hasTelegram: false }),
      item('fine000001', {}),
    ]);
    expect(row(el, 'staff00001').querySelector('.no-telegram')).not.toBeNull();
    expect(row(el, 'cand000001').querySelector('.no-telegram')).not.toBeNull();
    expect(row(el, 'fine000001').querySelector('.no-telegram')).toBeNull();
    http.verify();
  });

  it('owner: transfer to an admin without Telegram is disabled with a described explanation', async () => {
    const { el, http } = await render([
      item('adm0000001', { role: 'admin', hasTelegram: false }),
      item('adm0000002', { role: 'admin' }),
    ]);
    const blocked = row(el, 'adm0000001').querySelector<HTMLButtonElement>('button.transfer')!;
    expect(blocked.disabled).toBe(true);
    const hintId = blocked.getAttribute('aria-describedby')!;
    expect(el.querySelector(`#${hintId}`)!.textContent).toContain('admin.roles.telegramRequired');
    const ok = row(el, 'adm0000002').querySelector<HTMLButtonElement>('button.transfer')!;
    expect(ok.disabled).toBe(false);
    expect(ok.getAttribute('aria-describedby')).toBeNull();
    http.verify();
  });

  it('picking a staff role for a user without Telegram disables Save and explains why', async () => {
    const u = item('cand000001', { hasTelegram: false });
    const { fixture, el, http, cmp } = await render([u]);
    cmp.pick(u, 'moderator');
    fixture.detectChanges();
    const save = row(el, 'cand000001').querySelector<HTMLButtonElement>('button.save')!;
    expect(save.disabled).toBe(true);
    expect(el.querySelector(`#${save.getAttribute('aria-describedby')}`)).not.toBeNull();
    http.verify();
  });

  it('409 TELEGRAM_REQUIRED from a stale list shows the error and blocks the row', async () => {
    const u = item('cand000001', {});
    const { fixture, el, http, cmp } = await render([u]);
    cmp.pick(u, 'moderator');
    const done = cmp.save(u);
    http
      .expectOne('/api/admin/users/cand000001/role')
      .flush(
        { error: { code: 'TELEGRAM_REQUIRED', message: 'x' } },
        { status: 409, statusText: 'Conflict' },
      );
    await done;
    fixture.detectChanges();
    expect(row(el, 'cand000001').querySelector('.row-notice.nri-alert')!.textContent).toContain(
      'errors.TELEGRAM_REQUIRED',
    );
    expect(row(el, 'cand000001').querySelector('.no-telegram')).not.toBeNull();
    expect(row(el, 'cand000001').querySelector<HTMLButtonElement>('button.save')!.disabled).toBe(
      true,
    );
    http.verify();
  });
});
