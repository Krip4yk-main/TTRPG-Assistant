import { ComponentFixture, DeferBlockState, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { MeDto } from '@nri/shared';
import { QuestBoardShell } from './quest-board-shell';
import { routes } from '../../../../app.routes';
import { AuthStore } from '../../../../core/auth/auth.store';
import { ViewModeStore } from '../../../../core/view-mode/view-mode.store';
import { SocketService } from '../../../../core/realtime/socket.service';

const me = {
  id: 1,
  publicId: 'abcdefghjk',
  nickname: 'Gandalf',
  avatarUrl: null,
  birthDate: '1990-01-01',
  role: 'user',
  status: 'active',
  timezone: 'Europe/Kyiv',
  locale: 'uk',
  uiTheme: 'quest-board',
  availableThemes: ['quest-board'],
  uiPrefs: { tearAnimation: true, sendAnimation: true },
  myLimits: [],
  avatarSource: 'auto',
  customAvatarUrl: null,
  avatarOptions: [],
  identities: [],
} satisfies MeDto;

describe('QuestBoardShell (slot «shell»)', () => {
  let fixture: ComponentFixture<QuestBoardShell>;
  let http: HttpTestingController;
  let el: HTMLElement;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [QuestBoardShell],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(routes, withComponentInputBinding()),
        provideTranslateService(),
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            on: () => new Subject(),
            connected$: new Subject(),
            isConnected: () => false,
            sessionLost$: new Subject(),
          },
        },
      ],
    }).compileComponents();
    TestBed.inject(AuthStore).setMe(me);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(QuestBoardShell);
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => {
    // Дзвіночок сповіщень тягне лічильник непрочитаних для активного користувача.
    http.match('/api/me/notifications/unread-count').forEach((r) => r.flush({ count: 0 }));
    // «Оцінити» (окремий відкладений блок) тягне список відкритих оцінок.
    http.match('/api/me/ratings/pending').forEach((r) => r.flush([]));
    // Банер санкцій (відкладений блок) тягне мої чинні санкції.
    http.match('/api/me/sanctions').forEach((r) => r.flush([]));
    http.verify();
    localStorage.clear();
  });

  it('GM view: «My games» and «New game» in the nav and in the narrow-screen menu', async () => {
    TestBed.inject(ViewModeStore).setMode('gm');
    await settle();
    expect(el.querySelector('.nav a[href="/my-games"]')).not.toBeNull();
    expect(el.querySelector('.nav a[href="/games/new"]')).not.toBeNull();
    expect(el.querySelector('a[href="/my-applications"]')).toBeNull();
    el.querySelector<HTMLButtonElement>('.nav-menu-button')!.click();
    await settle();
    const menu = document.querySelector('.mat-mdc-menu-panel')!;
    expect(menu.querySelector('a[href="/my-games"]')).not.toBeNull();
    expect(menu.querySelector('a[href="/games/new"]')).not.toBeNull();
  });

  it('player view shows «My applications»', async () => {
    TestBed.inject(ViewModeStore).setMode('player');
    await settle();
    expect(el.querySelector('.nav a[href="/my-applications"]')).not.toBeNull();
    expect(el.querySelector('a[href="/my-games"]')).toBeNull();
  });

  it('view-mode toggle switches the mode', async () => {
    TestBed.inject(ViewModeStore).setMode('player');
    await settle();
    const gm = Array.from(el.querySelectorAll<HTMLButtonElement>('.view-mode button')).find((b) =>
      b.textContent!.includes('shell.viewMode.gm'),
    )!;
    gm.click();
    await settle();
    expect(TestBed.inject(ViewModeStore).mode()).toBe('gm');
  });

  it('account button shows the nickname initial and opens the account menu', async () => {
    await settle();
    const avatar = el.querySelector<HTMLButtonElement>('button.avatar')!;
    expect(avatar.getAttribute('aria-label')).toBe('shell.accountMenu');
    expect(avatar.textContent!.trim()).toBe('G');
    avatar.click();
    await settle();
    const menu = document.querySelector('.mat-mdc-menu-panel')!;
    expect(menu.querySelector('a[href="/users/abcdefghjk"]')).not.toBeNull();
    expect(menu.querySelector('a[href="/account"]')).not.toBeNull();
    expect(menu.querySelector('a[href="/admin"]')).toBeNull();
    expect(menu.textContent).toContain('shell.logout');
  });

  it('staff sees «Admin» in the account menu', async () => {
    TestBed.inject(AuthStore).setMe({ ...me, role: 'moderator' });
    await settle();
    el.querySelector<HTMLButtonElement>('button.avatar')!.click();
    await settle();
    expect(document.querySelector('.mat-mdc-menu-panel a[href="/admin"]')).not.toBeNull();
  });

  it('guest gets the login link and no account controls', async () => {
    TestBed.inject(AuthStore).setMe(null);
    await settle();
    expect(el.querySelector('a[href="/login"]')).not.toBeNull();
    expect(el.querySelector('button.avatar')).toBeNull();
    expect(el.querySelector('.view-mode')).toBeNull();
    expect(el.querySelectorAll('nri-guest-theme-toggle button[aria-pressed]')).toHaveLength(2);
  });

  it('a logged-in user does not see the guest design toggle', async () => {
    await settle();
    expect(el.querySelector('nri-guest-theme-toggle [role="group"]')).toBeNull();
  });

  it('has the skip link, the main landmark and the footer «About» link', async () => {
    await settle();
    expect(el.querySelector('a.skip-link[href="#main-content"]')).not.toBeNull();
    expect(el.querySelector('main#main-content')).not.toBeNull();
    expect(el.querySelector('footer a[href="/about"]')).not.toBeNull();
  });

  it('active user gets the notification bell (deferred chunk, reserved placeholder)', async () => {
    await settle();
    // Перший відкладений блок — «Оцінити», другий — дзвіночок.
    const [, block] = await fixture.getDeferBlocks();
    await block!.render(DeferBlockState.Placeholder);
    expect(el.querySelector('.bell-placeholder')).not.toBeNull();
    await block!.render(DeferBlockState.Complete);
    await settle();
    expect(el.querySelector('nri-notification-bell button.bell')).not.toBeNull();
    http.expectOne('/api/me/notifications/unread-count').flush({ count: 0 });
  });
});
