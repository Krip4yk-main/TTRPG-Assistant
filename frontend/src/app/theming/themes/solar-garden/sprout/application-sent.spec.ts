import { fakeAnimate } from '../../../../../testing/fake-animate';
import { growSprout } from './application-sent';

const TEXTS: Record<string, string> = {
  'theme.effects.solarGarden.packet': 'Насіння гри',
  'theme.effects.solarGarden.tag': 'Заявку подано',
};
const text = (key: string) => TEXTS[key] ?? key;

describe('growSprout («Сонячний сад»: паросток)', () => {
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
    document.querySelectorAll('.sg-send').forEach((o) => o.remove());
  });

  it('seed falls, sprout grows with the uk.json tag within 1.6 s, then removes itself', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const done = growSprout(source, new AbortController().signal, text);
    const overlay = document.querySelector('.sg-send')!;
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    const bed = overlay.querySelector<HTMLElement>('.sg-send-bed')!;
    expect(bed.style.width).toBe('232px');
    expect(overlay.querySelector('.sg-send-packet')!.textContent).toBe('Насіння гри');
    expect(overlay.querySelector('.sg-send-seed')).not.toBeNull();
    // Сім'ядолі й бирка — на верхівці стебла (крона), а не всередині стебла, що розтягується.
    const crown = overlay.querySelector('.sg-send-crown')!;
    expect(crown.querySelectorAll('.sg-send-leaf')).toHaveLength(2);
    expect(crown.querySelector('.sg-send-tag')!.textContent).toBe('Заявку подано');
    // Друга фаза росту не перекриває першу до свого старту.
    const stem = overlay.querySelector('.sg-send-stem')!;
    const stemAnims = anims.filter((a) => a.target === stem);
    expect(stemAnims.map((a) => a.options.fill)).toEqual(['both', 'forwards']);
    // Сам діалог ефект не чіпає.
    expect(anims.some((a) => a.target === source)).toBe(false);
    // Тривалість 2–3 с (запит власника: встигнути роздивитися).
    expect(lastEnd(anims)).toBeGreaterThanOrEqual(2000);
    expect(lastEnd(anims)).toBeLessThanOrEqual(3000);
    anims.forEach((a) => a.resolve());
    await done;
    expect(document.querySelector('.sg-send')).toBeNull();
  });

  it('narrow dialog (375 px screen): the bed fits inside it', async () => {
    source.getBoundingClientRect = () =>
      ({ left: 16, top: 60, width: 200, height: 160, right: 216, bottom: 220 }) as DOMRect;
    const { animate } = fakeAnimate(true);
    Element.prototype.animate = animate;
    const done = growSprout(source, new AbortController().signal, text);
    const bed = document.querySelector<HTMLElement>('.sg-send-bed')!;
    expect(bed.style.width).toBe('176px');
    expect(bed.style.height).toBe('136px');
    await done;
  });

  it('abort cancels the animations and removes the bed at once', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const abort = new AbortController();
    const done = growSprout(source, abort.signal, text);
    abort.abort();
    await done;
    expect(document.querySelector('.sg-send')).toBeNull();
    expect(anims.every((a) => a.cancel.mock.calls.length === 1)).toBe(true);
  });

  it('without Web Animations does nothing', async () => {
    (Element.prototype as { animate?: unknown }).animate = undefined;
    await growSprout(source, new AbortController().signal, text);
    expect(document.querySelector('.sg-send')).toBeNull();
  });
});

function lastEnd(anims: { options: KeyframeAnimationOptions }[]): number {
  return Math.max(
    ...anims.map((a) => Number(a.options.delay ?? 0) + Number(a.options.duration ?? 0)),
  );
}
