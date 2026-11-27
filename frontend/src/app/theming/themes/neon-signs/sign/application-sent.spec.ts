import { fakeAnimate } from '../../../../../testing/fake-animate';
import { lightNeonSign } from './application-sent';

const KEY = 'theme.effects.neonSigns.sign';
const text = (key: string) => (key === KEY ? 'Заявку подано' : key);

describe('lightNeonSign («Неонові вивіски»: вивіска запалюється)', () => {
  let source: HTMLElement;
  const original = Element.prototype.animate;

  beforeEach(() => {
    source = document.createElement('div');
    document.body.append(source);
    source.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 600, height: 500, right: 600, bottom: 500 }) as DOMRect;
  });

  afterEach(() => {
    Element.prototype.animate = original;
    source.remove();
    document.querySelectorAll('.ns-send').forEach((o) => o.remove());
  });

  it('lights the uk.json caption letter by letter within 1.6 s, then removes itself', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const done = lightNeonSign(source, new AbortController().signal, text);
    const overlay = document.querySelector('.ns-send')!;
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    // Слово — рядок, літера — трубка.
    const lines = overlay.querySelectorAll('.ns-send-lines .ns-send-line');
    expect(Array.from(lines, (l) => l.textContent)).toEqual(['Заявку', 'подано']);
    expect(overlay.querySelectorAll('.ns-send-letter')).toHaveLength(12);
    expect(overlay.querySelector('.ns-send-tube')).not.toBeNull();
    expect(overlay.querySelector('.ns-send-reflection')!.textContent).toBe('Заявкуподано');
    // Діалог гасне анімацією (не стилем) — переривання поверне його.
    expect(anims.some((a) => a.target === source)).toBe(true);
    expect(source.style.opacity).toBe('');
    // Тривалість 2–3 с (запит власника: встигнути роздивитися).
    expect(lastEnd(anims)).toBeGreaterThanOrEqual(2000);
    expect(lastEnd(anims)).toBeLessThanOrEqual(3000);
    anims.forEach((a) => a.resolve());
    await done;
    expect(document.querySelector('.ns-send')).toBeNull();
  });

  it('abort cancels the animations (the dialog shows again) and removes the sign at once', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const abort = new AbortController();
    const done = lightNeonSign(source, abort.signal, text);
    abort.abort();
    await done;
    expect(document.querySelector('.ns-send')).toBeNull();
    expect(anims.every((a) => a.cancel.mock.calls.length === 1)).toBe(true);
  });

  it('without Web Animations does nothing', async () => {
    (Element.prototype as { animate?: unknown }).animate = undefined;
    await lightNeonSign(source, new AbortController().signal, text);
    expect(document.querySelector('.ns-send')).toBeNull();
  });
});

function lastEnd(anims: { options: KeyframeAnimationOptions }[]): number {
  return Math.max(
    ...anims.map((a) => Number(a.options.delay ?? 0) + Number(a.options.duration ?? 0)),
  );
}
