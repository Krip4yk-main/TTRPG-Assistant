import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import type { ThemeId } from '@nri/shared';
import { ThemeService } from '../theme.service';
import { GuestThemeToggle } from './guest-theme-toggle';

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

  it('keyboard focus moves to the same button in the new header after the shell swap', async () => {
    document.body.appendChild(el);
    try {
      buttons()[1]!.focus();
      buttons()[1]!.click();
      // Стара шапка зникає разом із кнопкою, нова — з власним перемикачем.
      const fresh = document.createElement('nri-guest-theme-toggle');
      fresh.append(el.firstElementChild!.cloneNode(true));
      el.replaceWith(fresh);
      await vi.waitFor(() =>
        expect((document.activeElement as HTMLElement).dataset['themeId']).toBe('night-city'),
      );
      expect(fresh.contains(document.activeElement)).toBe(true);
      fresh.remove();
    } finally {
      el.remove();
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
