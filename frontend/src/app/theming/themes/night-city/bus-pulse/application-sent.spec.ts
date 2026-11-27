import { fakeAnimate } from '../../../../../testing/fake-animate';
import { pulseAlongBus } from './application-sent';

const KEY = 'theme.effects.nightCity.status';
const text = (key: string) => (key === KEY ? 'Заявку передано' : key);

describe('pulseAlongBus («Нічне місто»: імпульс по шині)', () => {
  let source: HTMLElement;
  const original = Element.prototype.animate;
  const rectAt = (top: number) =>
    ({ left: 100, top, width: 600, height: 500, right: 700, bottom: top + 500 }) as DOMRect;

  beforeEach(() => {
    source = document.createElement('div');
    document.body.append(source);
    source.getBoundingClientRect = () => rectAt(80);
  });

  afterEach(() => {
    Element.prototype.animate = original;
    source.remove();
    document.querySelectorAll('.nc-send').forEach((o) => o.remove());
  });

  it('bus with three clamps, a pulse and the uk.json status within 1.6 s, then removes itself', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const done = pulseAlongBus(source, new AbortController().signal, text);
    const overlay = document.querySelector('.nc-send')!;
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(overlay.querySelectorAll('.nc-send-clamp .nc-send-diode')).toHaveLength(3);
    expect(overlay.querySelector('.nc-send-pulse')).not.toBeNull();
    expect(overlay.querySelector('.nc-send-status')!.textContent).toBe('Заявку передано');
    // Над діалогом є місце — шина над ним.
    expect(overlay.querySelector<HTMLElement>('.nc-send-bus')!.style.top).toBe('-18px');
    // Сам діалог ефект не чіпає.
    expect(anims.some((a) => a.target === source)).toBe(false);
    const end = Math.max(
      ...anims.map((a) => Number(a.options.delay ?? 0) + Number(a.options.duration ?? 0)),
    );
    expect(end).toBeLessThanOrEqual(1600);
    anims.forEach((a) => a.resolve());
    await done;
    expect(document.querySelector('.nc-send')).toBeNull();
  });

  it('a dialog at the very top: the bus runs along its top edge', async () => {
    Element.prototype.animate = fakeAnimate(true).animate;
    source.getBoundingClientRect = () => rectAt(0);
    const done = pulseAlongBus(source, new AbortController().signal, text);
    expect(document.querySelector<HTMLElement>('.nc-send-bus')!.style.top).toBe('10px');
    await done;
    expect(document.querySelector('.nc-send')).toBeNull();
  });

  it('abort removes everything at once', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const abort = new AbortController();
    const done = pulseAlongBus(source, abort.signal, text);
    abort.abort();
    await done;
    expect(document.querySelector('.nc-send')).toBeNull();
    expect(anims.every((a) => a.cancel.mock.calls.length === 1)).toBe(true);
  });
});
