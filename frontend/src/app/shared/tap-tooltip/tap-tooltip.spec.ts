import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { MATERIAL_ANIMATIONS } from '@angular/material/core';
import { MatTooltip } from '@angular/material/tooltip';
import { COARSE_POINTER_QUERY, TapTooltip } from './tap-tooltip';

@Component({
  imports: [MatTooltip, TapTooltip],
  templateUrl: './tap-tooltip.spec.html',
})
class Host {}

describe('TapTooltip', () => {
  const original = window.matchMedia;

  let mediaChange: ((e: { matches: boolean }) => void) | null = null;

  const mockMedia = (coarse: boolean) => {
    mediaChange = null;
    window.matchMedia = vi.fn((query: string) => ({
      matches: coarse && query === COARSE_POINTER_QUERY,
      media: query,
      onchange: null,
      addEventListener: vi.fn((_: string, fn: (e: { matches: boolean }) => void) => {
        mediaChange = fn;
      }),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  };

  const setup = () => {
    // Без анімацій Material: «сховано» приходить одразу, без animationend.
    TestBed.configureTestingModule({
      providers: [{ provide: MATERIAL_ANIMATIONS, useValue: { animationsDisabled: true } }],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const de = fixture.debugElement.query(By.css('.info'));
    const tooltip = de.injector.get(MatTooltip);
    vi.spyOn(tooltip, 'show');
    vi.spyOn(tooltip, 'hide');
    const button = de.nativeElement as HTMLButtonElement;
    const tap = (el: Element) => {
      el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      (el as HTMLElement).click();
      fixture.detectChanges();
    };
    return { fixture, tooltip, button, tap };
  };

  afterEach(() => {
    window.matchMedia = original;
  });

  it('touch screen: a tap opens the explanation, a tap elsewhere closes it', () => {
    mockMedia(true);
    const { fixture, tooltip, button, tap } = setup();
    expect(tooltip.touchGestures).toBe('off');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Докладніше');

    tap(button);
    expect(tooltip.show).toHaveBeenCalledWith(0);
    expect(button.getAttribute('aria-expanded')).toBe('true');

    tap(fixture.nativeElement.querySelector('.elsewhere'));
    expect(tooltip.hide).toHaveBeenCalledWith(0);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('touch screen: tapping the (i) again closes it; Esc closes it too', () => {
    mockMedia(true);
    const { fixture, tooltip, button, tap } = setup();
    tap(button);
    tap(button);
    expect(tooltip.hide).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('aria-expanded')).toBe('false');

    tap(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(tooltip.hide).toHaveBeenCalledTimes(2);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    // Закрите — сторонні натискання більше нічого не роблять.
    tap(fixture.nativeElement.querySelector('.elsewhere'));
    expect(tooltip.hide).toHaveBeenCalledTimes(2);
  });

  it('desktop: clicks do nothing extra (hover tooltip as before), no aria-expanded', () => {
    mockMedia(false);
    const { tooltip, button, tap } = setup();
    expect(tooltip.touchGestures).toBe('auto');
    tap(button);
    expect(tooltip.show).not.toHaveBeenCalled();
    expect(button.hasAttribute('aria-expanded')).toBe(false);
    expect(tooltip.message).toBe('Пояснення');
  });

  it('touch screen: when Material hides the tooltip itself, the state follows; next tap shows', async () => {
    mockMedia(true);
    const { fixture, tooltip, button, tap } = setup();
    tap(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await vi.waitFor(() => expect(tooltip._isTooltipVisible()).toBe(true));
    // Material сам ховає (прокрутка, перерозміщення).
    tooltip.hide(0);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(button.getAttribute('aria-expanded')).toBe('false');
    });
    tap(button);
    expect(tooltip.show).toHaveBeenCalledTimes(2);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('touch screen: Esc closes only the explanation (does not reach a surrounding dialog)', () => {
    mockMedia(true);
    const { fixture, button, tap } = setup();
    const outer = vi.fn();
    fixture.nativeElement.addEventListener('keydown', outer);
    tap(button);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    button.dispatchEvent(esc);
    fixture.detectChanges();
    expect(esc.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    // Закрите — Esc іде далі як завжди.
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('touch screen: emulated mouse events showing the tooltip before click do not close it', () => {
    mockMedia(true);
    const { fixture, tooltip, button } = setup();
    button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    // Емульоване після дотику наведення вже показало підказку Material.
    tooltip.show(0);
    button.click();
    fixture.detectChanges();
    expect(tooltip.hide).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('switches between touch and desktop behaviour when the media query changes', () => {
    mockMedia(true);
    const { fixture, tooltip, button, tap } = setup();
    tap(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    // Стало десктопом (під'єднали мишу): пояснення закривається, натискання — як раніше.
    mediaChange!({ matches: false });
    fixture.detectChanges();
    expect(tooltip.hide).toHaveBeenCalledTimes(1);
    expect(button.hasAttribute('aria-expanded')).toBe(false);
    tap(button);
    expect(tooltip.show).toHaveBeenCalledTimes(1);
    // Знову дотиковий: натискання відкриває.
    mediaChange!({ matches: true });
    fixture.detectChanges();
    expect(tooltip.touchGestures).toBe('off');
    tap(button);
    expect(tooltip.show).toHaveBeenCalledTimes(2);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('stops listening to the document when destroyed', () => {
    mockMedia(true);
    const { fixture, button, tap } = setup();
    tap(button);
    const remove = vi.spyOn(document, 'removeEventListener');
    fixture.destroy();
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    remove.mockRestore();
  });
});
