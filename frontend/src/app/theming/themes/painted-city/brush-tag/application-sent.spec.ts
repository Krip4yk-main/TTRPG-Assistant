import { fakeAnimate } from '../../../../../testing/fake-animate';
import { paintBrushTag } from './application-sent';

const KEY = 'theme.effects.paintedCity.tag';
const text = (key: string) => (key === KEY ? 'Я в грі!' : key);

describe('paintBrushTag («Мальоване місто»: тег пензлем)', () => {
  let source: HTMLElement;
  const original = Element.prototype.animate;

  beforeEach(() => {
    source = document.createElement('div');
    document.body.append(source);
    source.getBoundingClientRect = () =>
      ({ left: 100, top: 80, width: 560, height: 420, right: 660, bottom: 500 }) as DOMRect;
  });

  afterEach(() => {
    Element.prototype.animate = original;
    source.remove();
    document.querySelectorAll('.pc-send').forEach((o) => o.remove());
  });

  it('the brush paints the uk.json tag stroke by stroke, drips and underline within 1.6 s', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const done = paintBrushTag(source, new AbortController().signal, text);
    const overlay = document.querySelector('.pc-send')!;
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(overlay.querySelector('.pc-send-text')!.textContent).toBe('Я в грі!');
    // Мазок — по літері, зліва направо; пробіли не малюються (пензель відривається).
    const letters = Array.from(overlay.querySelectorAll('.pc-send-letter'));
    expect(letters.map((l) => l.textContent)).toEqual(['Я', 'в', 'г', 'р', 'і', '!']);
    const starts = letters.map((l) => Number(anims.find((a) => a.target === l)!.options.delay));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    const gaps = Array.from(overlay.querySelectorAll('.pc-send-gap'));
    expect(gaps).toHaveLength(2);
    expect(anims.some((a) => gaps.includes(a.target))).toBe(false);
    // Патьоки — з «Я» та «і»; підкреслення й бризки.
    expect(overlay.querySelectorAll('.pc-send-drip')).toHaveLength(2);
    expect(overlay.querySelector('.pc-send-swoosh')).not.toBeNull();
    expect(overlay.querySelectorAll('.pc-send-splat')).toHaveLength(3);
    expect(overlay.querySelector('.pc-send-brush')).not.toBeNull();
    // Сам діалог ефект не чіпає.
    expect(anims.some((a) => a.target === source)).toBe(false);
    expect(lastEnd(anims)).toBeLessThanOrEqual(1600);
    anims.forEach((a) => a.resolve());
    await done;
    expect(document.querySelector('.pc-send')).toBeNull();
  });

  it('abort cancels the animations and removes the tag at once', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const abort = new AbortController();
    const done = paintBrushTag(source, abort.signal, text);
    abort.abort();
    await done;
    expect(document.querySelector('.pc-send')).toBeNull();
    expect(anims.every((a) => a.cancel.mock.calls.length === 1)).toBe(true);
  });

  it('without Web Animations does nothing', async () => {
    (Element.prototype as { animate?: unknown }).animate = undefined;
    await paintBrushTag(source, new AbortController().signal, text);
    expect(document.querySelector('.pc-send')).toBeNull();
  });
});

function lastEnd(anims: { options: KeyframeAnimationOptions }[]): number {
  return Math.max(
    ...anims.map((a) => Number(a.options.delay ?? 0) + Number(a.options.duration ?? 0)),
  );
}
