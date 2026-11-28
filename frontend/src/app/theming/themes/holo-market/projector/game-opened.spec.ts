import { fakeAnimate } from '../../../../../testing/fake-animate';
import { foldIntoProjector } from './game-opened';

const text = (key: string) => key;

describe('foldIntoProjector («Голо-ринок»: згортання картки в проєктор)', () => {
  let source: HTMLElement;
  let panel: HTMLElement;
  let puck: HTMLElement;
  const original = Element.prototype.animate;

  beforeEach(() => {
    // Хост картки сцени: панель і шайба-проєктор під нею (`.sc-d3`).
    source = document.createElement('nri-sc-game-card');
    panel = document.createElement('article');
    panel.className = 'panel';
    puck = document.createElement('span');
    puck.className = 'sc-d3';
    source.append(puck, panel);
    document.body.append(source);
    source.getBoundingClientRect = () => rect(20, 100, 360, 380);
    panel.getBoundingClientRect = () => rect(20, 100, 360, 380);
  });

  afterEach(() => {
    Element.prototype.animate = original;
    source.remove();
    document.querySelectorAll('.hm-open').forEach((o) => o.remove());
  });

  it('folds the card into its projector (the puck stays), beams up; cleans up', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const done = foldIntoProjector(source, new AbortController().signal, text);
    const overlay = document.querySelector('.hm-open')!;
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    // Область — від верху картки до верху шайби (22 px під карткою).
    const region = overlay.querySelector<HTMLElement>('.hm-open-region')!;
    expect(region.style.bottom).toBe('-22px');
    for (const cls of ['puck', 'beam', 'scan']) {
      expect(overlay.querySelector(`.hm-open-${cls}`)).not.toBeNull();
    }
    // Панель картки складається вниз у лінзу шайби: точка стиснення — лінза (центр по ширині,
    // 22 px під низом картки: 380 + 22 = 402 від верху панелі), без зсуву — лише масштаб.
    const fold = anims.find((a) => a.target === panel)!;
    expect(fold.options.fill).toBe('forwards');
    expect(fold.frames.every((f) => f['transformOrigin'] === '180px 402px')).toBe(true);
    expect(fold.frames.some((f) => String(f['transform']).includes('translate'))).toBe(false);
    // Висота спадає монотонно (верх опускається до шайби), ширина звужується до лінзи (90/360).
    const scales = fold.frames.map((f) =>
      String(f['transform'])
        .match(/scale\(([\d.]+), ([\d.]+)\)/)!
        .slice(1)
        .map(Number),
    );
    for (let i = 1; i < scales.length; i++) {
      expect(scales[i][0]).toBeLessThanOrEqual(scales[i - 1][0]);
      expect(scales[i][1]).toBeLessThan(scales[i - 1][1]);
    }
    expect(scales.at(-2)).toEqual([0.25, 0.04]);
    expect(scales.at(-1)![1]).toBeLessThanOrEqual(0.01);
    // Хроматичне розшарування під час складання.
    expect(String(fold.frames[1]['filter'])).toContain('#ff5cb4');
    expect(fold.frames.at(-1)!['opacity']).toBe(0);
    // Шайбу картки ефект не чіпає, і стилів по ефекту немає (лише анімації).
    expect(anims.some((a) => a.target === puck)).toBe(false);
    expect(panel.style.transform).toBe('');
    expect(lastEnd(anims)).toBeLessThanOrEqual(1600);
    anims.forEach((a) => a.resolve());
    await done;
    expect(document.querySelector('.hm-open')).toBeNull();
  });

  it('abort cancels every animation (the card shows again) and removes the overlay at once', async () => {
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

  it('a tiny card: nothing is animated', async () => {
    const { animate } = fakeAnimate(true);
    Element.prototype.animate = animate;
    source.getBoundingClientRect = () => rect(20, 100, 360, 30);
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
