import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import type { ThemeId } from '@nri/shared';
import { ThemeService } from '../theme.service';
import { FOCUS_HANDOFF_MS, GuestThemeToggle } from './guest-theme-toggle';

describe('GuestThemeToggle', () => {
  let fixture: ComponentFixture<GuestThemeToggle>;
  let el: HTMLElement;
  const isGuest = signal(true);
  const guestTheme = signal<ThemeId>('quest-board');
  const select = vi.fn((id: ThemeId) => {
    guestTheme.set(id);
    return Promise.resolve();
  });

  beforeEach(() => {
    isGuest.set(true);
    guestTheme.set('quest-board');
    select.mockClear();
    TestBed.configureTestingModule({
      imports: [GuestThemeToggle],
      providers: [
        provideTranslateService(),
        { provide: ThemeService, useValue: { isGuest, guestTheme, select } },
      ],
    });
    fixture = TestBed.createComponent(GuestThemeToggle);
    el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  });

  const buttons = () => Array.from(el.querySelectorAll<HTMLButtonElement>('button.option'));
  const pressed = () => buttons().map((b) => b.getAttribute('aria-pressed'));

  it('guest: a labelled group of two designs, the board first and pressed', () => {
    const group = el.querySelector('[role="group"]')!;
    expect(group.getAttribute('aria-label')).toBe('shell.guestTheme.label');
    expect(buttons().map((b) => b.dataset['themeId'])).toEqual(['quest-board', 'night-city']);
    expect(buttons().map((b) => b.textContent!.trim())).toEqual([
      expect.stringContaining('theme.names.quest-board'),
      expect.stringContaining('theme.names.night-city'),
    ]);
    expect(pressed()).toEqual(['true', 'false']);
  });

  it('clicking the other design calls select() and moves aria-pressed', () => {
    buttons()[1]!.click();
    fixture.detectChanges();
    expect(select).toHaveBeenCalledWith('night-city');
    expect(pressed()).toEqual(['false', 'true']);
  });

  /**
   * Зміна дизайну міняє каркас: старий перемикач знищується, новий з'являється в новій шапці.
   * `between` — що відбувається поміж ними (напр. користувач переводить фокус деінде).
   */
  const swapShell = (between?: () => void) => {
    fixture.destroy();
    between?.();
    const next = TestBed.createComponent(GuestThemeToggle);
    document.body.appendChild(next.nativeElement as HTMLElement);
    next.detectChanges();
    return next.nativeElement as HTMLElement;
  };

  describe('focus across the shell swap', () => {
    let fresh: HTMLElement | null = null;

    beforeEach(() => document.body.appendChild(el));
    afterEach(() => {
      fresh?.remove();
      document.querySelectorAll('input.elsewhere').forEach((i) => i.remove());
    });

    it('keyboard: focus moves to the pressed button of the new toggle', () => {
      buttons()[1]!.focus();
      buttons()[1]!.click();
      fresh = swapShell();
      const active = document.activeElement as HTMLElement;
      expect(fresh.contains(active)).toBe(true);
      expect(active.dataset['themeId']).toBe('night-city');
      expect(active.getAttribute('aria-pressed')).toBe('true');
    });

    it('focus moved to another element meanwhile stays there', () => {
      buttons()[1]!.focus();
      buttons()[1]!.click();
      const other = document.createElement('input');
      other.className = 'elsewhere';
      document.body.appendChild(other);
      fresh = swapShell(() => other.focus());
      expect(document.activeElement).toBe(other);
    });

    it('mouse click without focus on the button does not grab focus', () => {
      buttons()[1]!.click();
      fresh = swapShell();
      expect(fresh.contains(document.activeElement)).toBe(false);
    });

    it('a stale hand-off (past FOCUS_HANDOFF_MS) is ignored', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        buttons()[1]!.focus();
        buttons()[1]!.click();
        vi.setSystemTime(Date.now() + FOCUS_HANDOFF_MS + 1);
        fresh = swapShell();
        expect(fresh.contains(document.activeElement)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('wide screen: visible names, no redundant title; narrow: title on icon-only buttons', () => {
    // jsdom без matchMedia — як широкий екран.
    expect(buttons().every((b) => !b.hasAttribute('title'))).toBe(true);
    const original = window.matchMedia;
    const listeners: ((e: { matches: boolean }) => void)[] = [];
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: (_: string, l: (e: { matches: boolean }) => void) => listeners.push(l),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      const narrow = TestBed.createComponent(GuestThemeToggle);
      narrow.detectChanges();
      const titles = () =>
        Array.from((narrow.nativeElement as HTMLElement).querySelectorAll('button')).map((b) =>
          b.getAttribute('title'),
        );
      expect(titles()).toEqual(['theme.names.quest-board', 'theme.names.night-city']);
      listeners.forEach((l) => l({ matches: true }));
      narrow.detectChanges();
      expect(titles()).toEqual([null, null]);
    } finally {
      window.matchMedia = original;
    }
  });

  it('clicking the chosen design does nothing', () => {
    buttons()[0]!.click();
    expect(select).not.toHaveBeenCalled();
  });

  it('is hidden for a logged-in user', () => {
    isGuest.set(false);
    fixture.detectChanges();
    expect(el.querySelector('[role="group"]')).toBeNull();
    expect(buttons()).toHaveLength(0);
  });
});
