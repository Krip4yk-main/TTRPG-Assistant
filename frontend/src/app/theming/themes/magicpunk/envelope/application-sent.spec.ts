import { DUST_MS, sendInEnvelope } from './application-sent';

/** Підробна анімація WAAPI: завершується, коли тест скаже (або одразу). */
function fakeAnimate(autoFinish: boolean) {
  const anims: { cancel: ReturnType<typeof vi.fn>; resolve: () => void }[] = [];
  const animate = vi.fn(function (this: Element) {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const finished = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    finished.catch(() => undefined);
    const a = {
      finished,
      cancel: vi.fn(() => reject(new DOMException('', 'AbortError'))),
      resolve,
    };
    anims.push(a);
    if (autoFinish) resolve();
    return a as unknown as Animation;
  });
  return { animate, anims };
}

describe('sendInEnvelope («Магіпанк»: конверт заявки)', () => {
  let source: HTMLElement;
  const original = Element.prototype.animate;

  beforeEach(() => {
    source = document.createElement('div');
    source.className = 'surface';
    source.innerHTML =
      '<textarea class="answer" name="answer"></textarea><input type="checkbox" />' +
      '<input type="radio" name="pick" value="a" checked />';
    document.body.append(source);
    source.querySelector('textarea')!.value = 'Багато';
    source.querySelector<HTMLInputElement>('input')!.checked = true;
    source.getBoundingClientRect = () =>
      ({ left: 100, top: 50, width: 600, height: 540, right: 700, bottom: 590 }) as DOMRect;
  });

  afterEach(() => {
    Element.prototype.animate = original;
    source.remove();
    document.querySelectorAll('.mp-send').forEach((o) => o.remove());
    vi.useRealTimers();
  });

  it('builds a decorative overlay, hides the source, resolves, then removes the overlay', async () => {
    vi.useFakeTimers();
    Element.prototype.animate = fakeAnimate(true).animate;
    await sendInEnvelope(source, new AbortController().signal, String);
    const overlay = document.querySelector('.mp-send')!;
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(overlay.querySelectorAll('.mp-send-panel')).toHaveLength(3);
    expect(overlay.querySelector('.mp-send-seal')).not.toBeNull();
    expect(source.style.visibility).toBe('hidden');
    // Копії аркуша — зі значеннями полів оригіналу.
    const copies = overlay.querySelectorAll<HTMLTextAreaElement>('[data-mp-send-copy] textarea');
    expect(copies).toHaveLength(3);
    copies.forEach((t) => expect(t.value).toBe('Багато'));
    overlay
      .querySelectorAll<HTMLInputElement>('[data-mp-send-copy] input')
      .forEach((c) => expect(c.checked).toBe(true));
    // Копії полів — без `name` (однойменні радіокнопки не перемикали б оригінал).
    expect(overlay.querySelector('[data-mp-send-copy] [name]')).toBeNull();
    expect(source.querySelector<HTMLInputElement>('input[type="radio"]')!.checked).toBe(true);
    vi.advanceTimersByTime(DUST_MS + 60);
    expect(document.querySelector('.mp-send')).toBeNull();
  });

  it('a setup failure removes the overlay and shows the source again', async () => {
    Element.prototype.animate = fakeAnimate(true).animate;
    source.style.visibility = 'visible';
    source.cloneNode = () => {
      throw new Error('boom');
    };
    await sendInEnvelope(source, new AbortController().signal, String);
    expect(document.querySelector('.mp-send')).toBeNull();
    expect(source.style.visibility).toBe('visible');
  });

  it('abort cancels the animations and removes the overlay at once', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const abort = new AbortController();
    const done = sendInEnvelope(source, abort.signal, String);
    expect(document.querySelector('.mp-send')).not.toBeNull();
    abort.abort();
    await done;
    expect(document.querySelector('.mp-send')).toBeNull();
    expect(anims.every((a) => a.cancel.mock.calls.length === 1)).toBe(true);
  });

  it('without Web Animations (or a zero-sized source) does nothing', async () => {
    (Element.prototype as { animate?: unknown }).animate = undefined;
    await sendInEnvelope(source, new AbortController().signal, String);
    expect(document.querySelector('.mp-send')).toBeNull();
    expect(source.style.visibility).toBe('');

    Element.prototype.animate = fakeAnimate(true).animate;
    source.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    await sendInEnvelope(source, new AbortController().signal, String);
    expect(document.querySelector('.mp-send')).toBeNull();
  });
});
