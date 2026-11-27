import { fakeAnimate } from '../../testing/fake-animate';
import { runEffectStage, type EffectStage } from './effect-stage';

describe('runEffectStage (сцена фірмового ефекту)', () => {
  let source: HTMLElement;
  const original = Element.prototype.animate;

  beforeEach(() => {
    source = document.createElement('div');
    document.body.append(source);
    source.getBoundingClientRect = () =>
      ({ left: 40, top: 30, width: 500, height: 400, right: 540, bottom: 430 }) as DOMRect;
  });

  afterEach(() => {
    Element.prototype.animate = original;
    source.remove();
    document.querySelectorAll('.fx-test').forEach((o) => o.remove());
  });

  it('decorative overlay with a box over the source; waits for the animations, then removes it', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    let stage!: EffectStage;
    let done = false;
    const run = runEffectStage(source, new AbortController().signal, 'fx-test', (s) => {
      stage = s;
      s.play(s.add('dot'), [{ opacity: 0 }, { opacity: 1 }], [100, 300]);
    }).then(() => (done = true));
    expect(stage.root.getAttribute('aria-hidden')).toBe('true');
    expect(stage.root.inert).toBe(true);
    expect(stage.root.parentElement).toBe(document.body);
    expect(stage.box.style.left).toBe('40px');
    expect(stage.box.style.top).toBe('30px');
    expect(stage.box.style.width).toBe('500px');
    expect(stage.box.style.height).toBe('400px');
    expect(stage.box.querySelector('.dot')).not.toBeNull();
    expect(anims[0]!.options).toMatchObject({ delay: 100, duration: 200 });

    await Promise.resolve();
    expect(done).toBe(false);
    expect(document.querySelector('.fx-test')).not.toBeNull();
    anims[0]!.resolve();
    await run;
    expect(document.querySelector('.fx-test')).toBeNull();
    // Звичайне завершення анімацій не скасовує (стан `source` лишається до закриття).
    expect(anims[0]!.cancel).not.toHaveBeenCalled();
  });

  it('abort cancels every animation (the source returns as it was) and removes the overlay', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const abort = new AbortController();
    const run = runEffectStage(source, abort.signal, 'fx-test', ({ add, play }) => {
      play(source, [{ opacity: 1 }, { opacity: 0 }], [0, 200]);
      play(add('dot'), [{ opacity: 0 }, { opacity: 1 }], [0, 200]);
    });
    abort.abort();
    await run;
    expect(anims).toHaveLength(2);
    expect(anims.every((a) => a.cancel.mock.calls.length === 1)).toBe(true);
    expect(document.querySelector('.fx-test')).toBeNull();
  });

  it('a setup error removes the overlay, cancels started animations (also on the source) and rethrows', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const boom = new Error('boom');
    const run = runEffectStage(source, new AbortController().signal, 'fx-test', ({ play }) => {
      play(source, [{ opacity: 1 }, { opacity: 0 }], [0, 200]);
      throw boom;
    });
    await expect(run).rejects.toBe(boom);
    expect(document.querySelector('.fx-test')).toBeNull();
    expect(anims[0]!.target).toBe(source);
    expect(anims[0]!.cancel).toHaveBeenCalledTimes(1);
  });

  it('nothing happens without Web Animations, for a zero-sized source or an aborted signal', async () => {
    const setup = vi.fn();
    (Element.prototype as { animate?: unknown }).animate = undefined;
    await runEffectStage(source, new AbortController().signal, 'fx-test', setup);

    Element.prototype.animate = fakeAnimate(true).animate;
    const aborted = new AbortController();
    aborted.abort();
    await runEffectStage(source, aborted.signal, 'fx-test', setup);
    source.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    await runEffectStage(source, new AbortController().signal, 'fx-test', setup);
    expect(setup).not.toHaveBeenCalled();
    expect(document.querySelector('.fx-test')).toBeNull();
  });
});
