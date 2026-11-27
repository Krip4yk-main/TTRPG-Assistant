import { fakeAnimate } from '../../testing/fake-animate';
import { openEffectStage } from './effect-stage';

describe('openEffectStage (сцена фірмового ефекту)', () => {
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

  it('decorative overlay with a box over the source; finish waits for animations, then removes it', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const stage = openEffectStage(source, new AbortController().signal, 'fx-test')!;
    expect(stage.root.getAttribute('aria-hidden')).toBe('true');
    expect(stage.root.inert).toBe(true);
    expect(stage.root.parentElement).toBe(document.body);
    expect(stage.box.style.left).toBe('40px');
    expect(stage.box.style.top).toBe('30px');
    expect(stage.box.style.width).toBe('500px');
    expect(stage.box.style.height).toBe('400px');
    const dot = stage.add('dot');
    expect(dot.parentElement).toBe(stage.box);
    stage.play(dot, [{ opacity: 0 }, { opacity: 1 }], [100, 300]);
    expect(anims[0]!.options).toMatchObject({ delay: 100, duration: 200 });

    let done = false;
    const finished = stage.finish().then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    expect(document.querySelector('.fx-test')).not.toBeNull();
    anims[0]!.resolve();
    await finished;
    expect(document.querySelector('.fx-test')).toBeNull();
    // Звичайне завершення анімацій не скасовує (стан `source` лишається до закриття).
    expect(anims[0]!.cancel).not.toHaveBeenCalled();
  });

  it('abort cancels every animation (the source returns as it was) and removes the overlay', async () => {
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const abort = new AbortController();
    const stage = openEffectStage(source, abort.signal, 'fx-test')!;
    stage.play(source, [{ opacity: 1 }, { opacity: 0 }], [0, 200]);
    stage.play(stage.add('dot'), [{ opacity: 0 }, { opacity: 1 }], [0, 200]);
    const finished = stage.finish();
    abort.abort();
    await finished;
    expect(anims.every((a) => a.cancel.mock.calls.length === 1)).toBe(true);
    expect(document.querySelector('.fx-test')).toBeNull();
  });

  it('no stage without Web Animations, for a zero-sized source or an aborted signal', () => {
    (Element.prototype as { animate?: unknown }).animate = undefined;
    expect(openEffectStage(source, new AbortController().signal, 'fx-test')).toBeNull();

    Element.prototype.animate = fakeAnimate(true).animate;
    const aborted = new AbortController();
    aborted.abort();
    expect(openEffectStage(source, aborted.signal, 'fx-test')).toBeNull();
    source.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    expect(openEffectStage(source, new AbortController().signal, 'fx-test')).toBeNull();
    expect(document.querySelector('.fx-test')).toBeNull();
  });
});
