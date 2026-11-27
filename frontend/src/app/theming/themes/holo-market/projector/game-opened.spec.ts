import { fakeAnimate } from '../../../../../testing/fake-animate';
import { foldIntoProjector } from './game-opened';

const text = (key: string) => key;

describe('foldIntoProjector («Голо-ринок»: згортання в проєктор)', () => {
  let source: HTMLElement;
  let head: HTMLElement;
  const original = Element.prototype.animate;

  beforeEach(() => {
    source = document.createElement('article');
    source.className = 'game';
    head = document.createElement('header');
    head.className = 'head';
    const h1 = document.createElement('h1');
    h1.textContent = '  Підземелля, яке ми вигадаємо разом ';
    head.append(h1);
    source.append(head);
    document.body.append(source);
    source.getBoundingClientRect = () => rect(20, 100, 700, 1400);
    head.getBoundingClientRect = () => rect(20, 300, 700, 160);
  });

  afterEach(() => {
    Element.prototype.animate = original;
    source.remove();
    document.querySelectorAll('.hm-open').forEach((o) => o.remove());
  });

  it('folds a holo panel with the title into the puck and unfolds the header upward; cleans up', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const done = foldIntoProjector(source, new AbortController().signal, text);
    const overlay = document.querySelector('.hm-open')!;
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    // Область — від верху статті до низу шапки (100…460 → 0…360 відносно статті).
    const region = overlay.querySelector<HTMLElement>('.hm-open-region')!;
    expect(region.style.top).toBe('0px');
    expect(region.style.height).toBe('360px');
    expect(overlay.querySelector('.hm-open-title')!.textContent).toBe(
      'Підземелля, яке ми вигадаємо разом',
    );
    for (const cls of ['panel', 'puck', 'beam', 'scan']) {
      expect(overlay.querySelector(`.hm-open-${cls}`)).not.toBeNull();
    }
    // Шапку ховає й розгортає clip-path на статті: від низу шапки догори; лише анімацією
    // (`backwards`) — по ефекту стилю немає.
    const reveal = anims.find((a) => a.target === source)!;
    expect(reveal.options.fill).toBe('backwards');
    expect(String(reveal.frames[0]!['clipPath'])).toMatch(/^inset\(360px /);
    expect(String(reveal.frames.at(-1)!['clipPath'])).toMatch(/^inset\(-48px /);
    expect(source.style.clipPath).toBe('');
    // Лінія світла летить у шайбу (на низ області) і зникає.
    const panel = anims.find((a) => a.target.classList.contains('hm-open-panel'))!;
    expect(String(panel.frames.at(-1)!['transform'])).toContain('translateY(180px)');
    expect(panel.frames.at(-1)!['opacity']).toBe(0);
    expect(lastEnd(anims)).toBeLessThanOrEqual(1600);
    anims.forEach((a) => a.resolve());
    await done;
    expect(document.querySelector('.hm-open')).toBeNull();
  });

  it('only the part of the header inside the window', async () => {
    const { animate, anims } = fakeAnimate(true);
    Element.prototype.animate = animate;
    source.getBoundingClientRect = () => rect(20, -60, 700, 1400);
    head.getBoundingClientRect = () => rect(20, 140, 700, 160);
    const done = foldIntoProjector(source, new AbortController().signal, text);
    const region = document.querySelector<HTMLElement>('.hm-open-region')!;
    expect(region.style.top).toBe('60px');
    expect(region.style.height).toBe('300px');
    const reveal = anims.find((a) => a.target === source)!;
    expect(String(reveal.frames.at(-1)!['clipPath'])).toMatch(/^inset\(60px /);
    await done;
  });

  it('abort cancels every animation (the header shows again) and removes the overlay at once', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const abort = new AbortController();
    const done = foldIntoProjector(source, abort.signal, text);
    abort.abort();
    await done;
    expect(document.querySelector('.hm-open')).toBeNull();
    expect(anims.length).toBeGreaterThan(0);
    expect(anims.every((a) => a.cancel.mock.calls.length === 1)).toBe(true);
  });

  it('a header scrolled out of the window: nothing is animated', async () => {
    const { animate } = fakeAnimate(true);
    Element.prototype.animate = animate;
    source.getBoundingClientRect = () => rect(20, -900, 700, 1400);
    head.getBoundingClientRect = () => rect(20, -600, 700, 160);
    await foldIntoProjector(source, new AbortController().signal, text);
    expect(animate).not.toHaveBeenCalled();
    expect(document.querySelector('.hm-open')).toBeNull();
  });

  it('without Web Animations does nothing', async () => {
    (Element.prototype as { animate?: unknown }).animate = undefined;
    await foldIntoProjector(source, new AbortController().signal, text);
    expect(document.querySelector('.hm-open')).toBeNull();
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
