import { fakeAnimate } from '../../../../../testing/fake-animate';
import { printTelegraphTape } from './application-sent';

const TEXTS: Record<string, string> = {
  'theme.effects.brassSteam.tape': 'Заявку подано STOP',
  'theme.effects.brassSteam.stamp': 'Відправлено',
};
const text = (key: string) => TEXTS[key] ?? key;

describe('printTelegraphTape («Латунь і пара»: телеграфна стрічка)', () => {
  let source: HTMLElement;
  const original = Element.prototype.animate;

  beforeEach(() => {
    source = document.createElement('div');
    document.body.append(source);
    source.getBoundingClientRect = () =>
      ({ left: 100, top: 80, width: 600, height: 500, right: 700, bottom: 580 }) as DOMRect;
  });

  afterEach(() => {
    Element.prototype.animate = original;
    source.remove();
    document.querySelectorAll('.bs-send').forEach((o) => o.remove());
  });

  it('tape printed letter by letter, stamp, gauge and steam within 1.6 s, then removes itself', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const done = printTelegraphTape(source, new AbortController().signal, text);
    const overlay = document.querySelector('.bs-send')!;
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    const tape = overlay.querySelector('.bs-send-well .bs-send-tape')!;
    expect(tape.textContent).toBe('Заявку подано STOP');
    expect(overlay.querySelector('.bs-send-stamp')!.textContent).toBe('Відправлено');
    expect(overlay.querySelector('.bs-send-gauge .bs-send-needle')).not.toBeNull();
    expect(overlay.querySelectorAll('.bs-send-steam').length).toBeGreaterThan(0);
    // Друк — ривками, крок на літеру.
    expect(anims.find((a) => a.target === tape)!.options.easing).toBe('steps(18, end)');
    // Сам діалог ефект не чіпає.
    expect(anims.some((a) => a.target === source)).toBe(false);
    const end = Math.max(
      ...anims.map((a) => Number(a.options.delay ?? 0) + Number(a.options.duration ?? 0)),
    );
    // Тривалість 2–3 с (запит власника: встигнути роздивитися).
    expect(end).toBeGreaterThanOrEqual(2000);
    expect(end).toBeLessThanOrEqual(3000);
    anims.forEach((a) => a.resolve());
    await done;
    expect(document.querySelector('.bs-send')).toBeNull();
  });

  it('abort removes everything at once', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const abort = new AbortController();
    const done = printTelegraphTape(source, abort.signal, text);
    abort.abort();
    await done;
    expect(document.querySelector('.bs-send')).toBeNull();
    expect(anims.every((a) => a.cancel.mock.calls.length === 1)).toBe(true);
  });
});
