import { fakeAnimate } from '../../../../../testing/fake-animate';
import { pressWaxSeal } from './accepted-notice';

const text = (key: string) => (key === 'theme.effects.gothicGloom.seal' ? 'З' : key);

describe('pressWaxSeal («Готичний морок»: сургучний вердикт)', () => {
  let source: HTMLElement;
  const original = Element.prototype.animate;

  beforeEach(() => {
    source = document.createElement('li');
    source.setAttribute('data-notification-id', '7');
    document.body.append(source);
    source.getBoundingClientRect = () => rect(600, 120, 380, 80);
  });

  afterEach(() => {
    Element.prototype.animate = original;
    source.remove();
    document.querySelectorAll('.gg-seal').forEach((o) => o.remove());
  });

  it('unfolds the row, drops wax, presses the ring and leaves the impression with a glint; cleans up', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const done = pressWaxSeal(source, new AbortController().signal, text);
    const overlay = document.querySelector('.gg-seal')!;
    expect(overlay.getAttribute('aria-hidden')).toBe('true');

    // Печатка в нижньому правому куті рядка (у полі під кнопкою видалення, не на тексті).
    const seal = overlay.querySelector<HTMLElement>('.gg-seal-seal')!;
    expect([seal.style.left, seal.style.top, seal.style.width, seal.style.height]).toEqual([
      '320px',
      '28px',
      '44px',
      '44px',
    ]);
    expect(overlay.querySelector('.gg-seal-letter')!.textContent).toBe('З');
    for (const part of [
      'line',
      'drop',
      'wax',
      'mark',
      'glint',
      'stamp',
      'handle',
      'knob',
      'face',
    ]) {
      expect(overlay.querySelectorAll(`.gg-seal-${part}`)).toHaveLength(1);
    }

    // Рядок розгортається згори вниз: `clip-path` лише на час розгортання (`backwards`).
    const [unfold, shudder] = anims.filter((a) => a.target === source);
    expect(unfold!.frames.map((f) => f['clipPath'])).toEqual([
      'inset(0 0 80px 0)',
      'inset(0 0 0 0)',
    ]);
    expect(unfold!.options.fill).toBe('backwards');
    // Здригання від удару — без сліду по ньому.
    expect(shudder!.options.fill).toBe('none');
    expect(shudder!.frames.at(-1)!['transform']).toBe('translateY(0)');

    // Сургуч: калюжка (до кінця — масштаб, з якого починає тиснення), тиснення `forwards`.
    const wax = overlay.querySelector('.gg-seal-wax')!;
    const [spread, press] = anims.filter((a) => a.target === wax);
    expect(spread!.frames.at(-1)!['transform']).toBe(press!.frames[0]!['transform']);
    expect(press!.options.fill).toBe('forwards');
    expect(Number(press!.options.delay)).toBeGreaterThanOrEqual(
      Number(spread!.options.delay) + Number(spread!.options.duration),
    );

    // Відбиток з'являється, коли перстень почав підніматися; перстень і печатка гаснуть.
    const stamp = anims.find((a) => a.target === overlay.querySelector('.gg-seal-stamp'))!;
    const mark = anims.find((a) => a.target === overlay.querySelector('.gg-seal-mark'))!;
    expect(Number(mark.options.delay)).toBeGreaterThan(Number(stamp.options.delay));
    expect(stamp.frames.at(-1)!['opacity']).toBe(0);
    const fade = anims.find((a) => a.target === seal)!;
    expect(fade.frames.at(-1)!['opacity']).toBe(0);

    expect(lastEnd(anims)).toBeLessThanOrEqual(1600);
    anims.forEach((a) => a.resolve());
    await done;
    expect(document.querySelector('.gg-seal')).toBeNull();
  });

  it('a low row gets a smaller seal', async () => {
    source.getBoundingClientRect = () => rect(600, 120, 380, 56);
    const { animate } = fakeAnimate(true);
    Element.prototype.animate = animate;
    const done = pressWaxSeal(source, new AbortController().signal, text);
    const seal = document.querySelector<HTMLElement>('.gg-seal-seal')!;
    expect([seal.style.width, seal.style.top]).toEqual(['32px', '16px']);
    await done;
    expect(document.querySelector('.gg-seal')).toBeNull();
  });

  it('abort cancels every animation (the row too) and removes the overlay at once', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const abort = new AbortController();
    const done = pressWaxSeal(source, abort.signal, text);
    abort.abort();
    await done;
    expect(document.querySelector('.gg-seal')).toBeNull();
    expect(anims.some((a) => a.target === source)).toBe(true);
    expect(anims.every((a) => a.cancel.mock.calls.length === 1)).toBe(true);
  });

  it('a row too low for a seal: nothing is animated', async () => {
    source.getBoundingClientRect = () => rect(600, 120, 380, 30);
    const { animate } = fakeAnimate(true);
    Element.prototype.animate = animate;
    await pressWaxSeal(source, new AbortController().signal, text);
    expect(animate).not.toHaveBeenCalled();
    expect(document.querySelector('.gg-seal')).toBeNull();
  });

  it('a row scrolled out of the panel list or past the window: nothing is animated', async () => {
    const list = document.createElement('div');
    list.style.overflowY = 'auto';
    document.body.append(list);
    list.append(source);
    list.getBoundingClientRect = () => rect(600, 100, 380, 300);
    source.getBoundingClientRect = () => rect(600, 380, 380, 80);
    const { animate } = fakeAnimate(true);
    Element.prototype.animate = animate;
    await pressWaxSeal(source, new AbortController().signal, text);
    // Під вікном (jsdom: 768 px заввишки).
    list.getBoundingClientRect = () => rect(600, 0, 380, 2000);
    source.getBoundingClientRect = () => rect(600, 740, 380, 80);
    await pressWaxSeal(source, new AbortController().signal, text);
    expect(animate).not.toHaveBeenCalled();
    expect(document.querySelector('.gg-seal')).toBeNull();
    list.remove();
  });

  it('a narrow window that cuts only the left edge of the row still gets the seal', async () => {
    source.getBoundingClientRect = () => rect(-60, 120, 360, 80);
    const { animate } = fakeAnimate(true);
    Element.prototype.animate = animate;
    await pressWaxSeal(source, new AbortController().signal, text);
    expect(animate).toHaveBeenCalled();
  });

  it('without Web Animations does nothing', async () => {
    (Element.prototype as { animate?: unknown }).animate = undefined;
    await pressWaxSeal(source, new AbortController().signal, text);
    expect(document.querySelector('.gg-seal')).toBeNull();
  });
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height } as DOMRect;
}

function lastEnd(anims: { options: KeyframeAnimationOptions }[]): number {
  return Math.max(
    ...anims.map((a) => Number(a.options.delay ?? 0) + Number(a.options.duration ?? 0)),
  );
}
