import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import type { ThemeId, UiPrefsDto } from '@nri/shared';
import uk from '../../../../assets/i18n/uk.json';
import { AuthStore } from '../../../core/auth/auth.store';
import { ThemeService } from '../../../theming/theme.service';
import { THEMES, THEME_REGISTRY } from '../../../theming/theme.registry';
import { ThemePicker } from './theme-picker';

/**
 * Підробний ThemeService: доступні дизайни, чинний і налаштування вигляду — сигнали,
 * `select` / `saveUiPrefs` — шпигуни.
 */
function fakeThemes(available: ThemeId[], current: ThemeId = 'quest-board') {
  const theme = signal<ThemeId>(current);
  const uiPrefs = signal<UiPrefsDto>({ tearAnimation: true, sendAnimation: true });
  return {
    theme,
    available: signal(available),
    uiPrefs,
    select: vi.fn(async (id: ThemeId) => {
      theme.set(id);
    }),
    saveUiPrefs: vi.fn(async (prefs: Partial<UiPrefsDto>) => {
      uiPrefs.set({ ...uiPrefs(), ...prefs });
    }),
  };
}

/** Реєстр без власних налаштувань «Дошки». */
const NO_OPTIONS = { ...THEMES, 'quest-board': { ...THEMES['quest-board'], options: [] } };

async function render(
  themes: ReturnType<typeof fakeThemes>,
  auth = { load: vi.fn(async () => {}) },
  registry = THEMES,
) {
  await TestBed.configureTestingModule({
    imports: [ThemePicker],
    providers: [
      provideTranslateService(),
      { provide: ThemeService, useValue: themes },
      { provide: AuthStore, useValue: auth },
      { provide: THEME_REGISTRY, useValue: registry },
    ],
  }).compileComponents();
  const translate = TestBed.inject(TranslateService);
  translate.setTranslation('uk', uk);
  translate.use('uk');
  const fixture = TestBed.createComponent(ThemePicker);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture;
}

const optionButtons = (el: HTMLElement) => [
  ...el.querySelectorAll<HTMLButtonElement>('button.option'),
];
const tearSwitch = (el: HTMLElement) =>
  el.querySelector<HTMLButtonElement>('mat-slide-toggle button[role="switch"]');
const byName = (el: HTMLElement, name: string) =>
  optionButtons(el).find((b) => b.textContent?.includes(name))!;

describe('ThemePicker («Вигляд»)', () => {
  it('прихований, коли доступний один дизайн і в нього немає власних налаштувань', async () => {
    const fixture = await render(fakeThemes(['quest-board']), undefined, NO_OPTIONS);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).not.toContain('Вигляд');
    expect(optionButtons(el)).toHaveLength(0);
  });

  it('один дизайн «Дошка»: без карток дизайнів, але з перемикачем анімації', async () => {
    const fixture = await render(fakeThemes(['quest-board']));
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('h2')?.textContent).toContain('Вигляд');
    expect(optionButtons(el)).toHaveLength(0);
    expect(el.textContent).toContain(uk.account.theme.tearAnimation);
    expect(tearSwitch(el)?.getAttribute('aria-checked')).toBe('true');
  });

  it('перемикач анімації зберігає налаштування в профілі', async () => {
    const themes = fakeThemes(['quest-board']);
    const fixture = await render(themes);
    tearSwitch(fixture.nativeElement)!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(themes.saveUiPrefs).toHaveBeenCalledWith({ tearAnimation: false });
    expect(tearSwitch(fixture.nativeElement)?.getAttribute('aria-checked')).toBe('false');
  });

  it('поки налаштування зберігається, перемикач лишається у фокусі (aria-disabled)', async () => {
    const themes = fakeThemes(['quest-board']);
    let done!: () => void;
    themes.saveUiPrefs.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
    );
    const fixture = await render(themes);
    const el: HTMLElement = fixture.nativeElement;
    document.body.appendChild(el);
    const sw = tearSwitch(el)!;
    sw.focus();
    sw.click();
    fixture.detectChanges();
    expect(sw.hasAttribute('disabled')).toBe(false);
    expect(sw.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(sw);
    // Повторний клік під час збереження нічого не надсилає.
    sw.click();
    expect(themes.saveUiPrefs).toHaveBeenCalledTimes(1);
    done();
    await fixture.whenStable();
    el.remove();
  });

  it('помилка збереження анімації — повідомлення й попередній стан перемикача', async () => {
    const themes = fakeThemes(['quest-board']);
    themes.saveUiPrefs.mockRejectedValue(
      new HttpErrorResponse({ status: 403, error: { error: { code: 'FORBIDDEN' } } }),
    );
    const fixture = await render(themes);
    const el: HTMLElement = fixture.nativeElement;
    tearSwitch(el)!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(tearSwitch(el)?.getAttribute('aria-checked')).toBe('true');
    expect(el.querySelector('[role="alert"]')?.textContent?.trim()).toBe(uk.errors.FORBIDDEN);
  });

  it('«Магіпанк»: перемикач «Фірмові анімації дизайну», зберігає лише sendAnimation', async () => {
    const themes = fakeThemes(['quest-board', 'magicpunk'], 'magicpunk');
    const fixture = await render(themes);
    const el: HTMLElement = fixture.nativeElement;
    expect(uk.account.theme.sendAnimation).toBe('Фірмові анімації дизайну');
    expect(el.textContent).toContain(uk.account.theme.sendAnimation);
    expect(el.textContent).toContain(uk.account.theme.sendAnimationHint);
    expect(el.textContent).not.toContain(uk.account.theme.tearAnimation);
    const sw = el.querySelector<HTMLButtonElement>(
      'mat-slide-toggle[data-option="sendAnimation"] button[role="switch"]',
    )!;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    sw.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(themes.saveUiPrefs).toHaveBeenCalledWith({ sendAnimation: false });
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('у «Нічного міста» власних налаштувань немає — лише картки', async () => {
    const fixture = await render(fakeThemes(['quest-board', 'night-city'], 'night-city'));
    const el: HTMLElement = fixture.nativeElement;
    expect(optionButtons(el)).toHaveLength(2);
    expect(tearSwitch(el)).toBeNull();
  });

  it('чотири дизайни: картки з мініатюрою й назвою, чинний позначений', async () => {
    const fixture = await render(
      fakeThemes(['quest-board', 'neon-signs', 'holo-market', 'night-city']),
    );
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('h2')?.textContent).toContain('Вигляд');
    expect(optionButtons(el).map((b) => b.querySelector('.name')!.textContent!.trim())).toEqual([
      'Дошка оголошень Обрано',
      'Неонові вивіски',
      'Голо-ринок',
      'Нічне місто',
    ]);
    const board = byName(el, 'Дошка оголошень');
    const city = byName(el, 'Нічне місто');
    expect(board.querySelector('img')?.getAttribute('src')).toBe('themes/quest-board.png');
    expect(city.querySelector('img')?.getAttribute('src')).toBe('themes/night-city.png');
    expect(board.getAttribute('aria-pressed')).toBe('true');
    expect(city.getAttribute('aria-pressed')).toBe('false');
    expect(board.textContent).toContain('Обрано');
  });

  it('клік обирає дизайн через ThemeService.select і позначає його', async () => {
    const themes = fakeThemes(['quest-board', 'night-city']);
    const fixture = await render(themes);
    const el: HTMLElement = fixture.nativeElement;
    byName(el, 'Нічне місто').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(themes.select).toHaveBeenCalledWith('night-city');
    expect(byName(el, 'Нічне місто').getAttribute('aria-pressed')).toBe('true');
    expect(byName(el, 'Дошка оголошень').getAttribute('aria-pressed')).toBe('false');
  });

  it('повторний клік по чинному дизайну нічого не зберігає', async () => {
    const themes = fakeThemes(['quest-board', 'night-city']);
    const fixture = await render(themes);
    byName(fixture.nativeElement, 'Дошка оголошень').click();
    await fixture.whenStable();
    expect(themes.select).not.toHaveBeenCalled();
  });

  it('помилка збереження — повідомлення й повернення попереднього вибору', async () => {
    const themes = fakeThemes(['quest-board', 'night-city']);
    let fail!: (err: unknown) => void;
    themes.select.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    );
    const fixture = await render(themes);
    const el: HTMLElement = fixture.nativeElement;
    byName(el, 'Нічне місто').click();
    fixture.detectChanges();
    // Поки зберігається — вибір позначено одразу, картки заблоковані.
    expect(byName(el, 'Нічне місто').getAttribute('aria-pressed')).toBe('true');
    expect(byName(el, 'Дошка оголошень').getAttribute('aria-disabled')).toBe('true');
    // Повторний клік під час збереження нічого не робить.
    byName(el, 'Дошка оголошень').click();
    expect(themes.select).toHaveBeenCalledTimes(1);

    fail(new HttpErrorResponse({ status: 403, error: { error: { code: 'FORBIDDEN' } } }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(byName(el, 'Дошка оголошень').getAttribute('aria-pressed')).toBe('true');
    expect(byName(el, 'Нічне місто').getAttribute('aria-pressed')).toBe('false');
    expect(byName(el, 'Нічне місто').getAttribute('aria-disabled')).toBeNull();
    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent?.trim()).toBe(uk.errors.FORBIDDEN);
  });

  it.each([
    ['THEME_NOT_AVAILABLE', 1],
    ['FORBIDDEN', 0],
  ])('помилка %s: оновлення користувача викликів — %i', async (code, calls) => {
    const themes = fakeThemes(['quest-board', 'night-city']);
    themes.select.mockRejectedValue(
      new HttpErrorResponse({ status: 403, error: { error: { code } } }),
    );
    const auth = { load: vi.fn(async () => {}) };
    const fixture = await render(themes, auth);
    byName(fixture.nativeElement, 'Нічне місто').click();
    await fixture.whenStable();
    expect(auth.load).toHaveBeenCalledTimes(calls);
  });
});
