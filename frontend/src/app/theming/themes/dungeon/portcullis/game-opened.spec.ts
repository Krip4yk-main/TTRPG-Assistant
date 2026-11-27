import { fakeAnimate } from '../../../../../testing/fake-animate';
import { raisePortcullis } from './game-opened';

const text = (key: string) => key;

describe('raisePortcullis («Підземелля»: підйом ґрат)', () => {
  let source: HTMLElement;
  let head: HTMLElement;
  const original = Element.prototype.animate;

  beforeEach(() => {
    source = document.createElement('article');
    source.className = 'game';
    head = document.createElement('header');
    head.className = 'head';
    source.append(head);
    document.body.append(source);
    source.getBoundingClientRect = () => rect(20, 120, 760, 1400);
    head.getBoundingClientRect = () => rect(20, 480, 760, 160);
  });

  afterEach(() => {
    Element.prototype.animate = original;
    source.remove();
    document.querySelectorAll('.dg-open').forEach((o) => o.remove());
  });

  function addCover(): HTMLElement {
    const cover = document.createElement('img');
    cover.className = 'cover';
    cover.style.borderRadius = '6px';
    source.prepend(cover);
    cover.getBoundingClientRect = () => rect(20, 120, 760, 340);
    return cover;
  }

  it('drops the grate on the cover and raises it in three jerks with chains and dust; cleans up', async () => {
    addCover();
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const done = raisePortcullis(source, new AbortController().signal, text);
    const overlay = document.querySelector('.dg-open')!;
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    const frame = overlay.querySelector<HTMLElement>('.dg-open-frame')!;
    expect([frame.style.left, frame.style.top, frame.style.width, frame.style.height]).toEqual([
      '0px',
      '0px',
      '760px',
      '340px',
    ]);
    expect(frame.style.borderRadius).toBe('6px');
    expect(overlay.querySelectorAll('.dg-open-bar')).toHaveLength(20);
    expect(overlay.querySelectorAll('.dg-open-rail')).toHaveLength(3);
    expect(overlay.querySelectorAll('.dg-open-chain')).toHaveLength(2);
    // Пил: від удару й на кожному з трьох смиків.
    expect(overlay.querySelectorAll('.dg-open-dust')).toHaveLength(20);
    expect(overlay.querySelector('.dg-open-flare')).not.toBeNull();

    const grate = overlay.querySelector('.dg-open-grate')!;
    const [drop, rise] = anims.filter((a) => a.target === grate);
    // Падає згори (вся висота + кінці прутів) і впирається вниз.
    expect(drop!.frames[0]!['transform']).toBe('translateY(-356px)');
    expect(drop!.frames.at(-1)!['transform']).toBe('translateY(0px)');
    // Підйом — три ривки (з осіданням) під верхній край; `forwards`, щоб не перекрити падіння.
    expect(rise!.options.fill).toBe('forwards');
    const lifts = rise!.frames.map((f) => String(f['transform']));
    expect(lifts.at(-1)).toBe('translateY(-356px)');
    expect(new Set(lifts).size).toBe(6);
    // Сторінку ефект не чіпає.
    expect(anims.some((a) => a.target === source || source.contains(a.target))).toBe(false);
    expect(lastEnd(anims)).toBeLessThanOrEqual(1600);
    anims.forEach((a) => a.resolve());
    await done;
    expect(document.querySelector('.dg-open')).toBeNull();
  });

  it('without a cover the grate drops on the header', async () => {
    const { animate } = fakeAnimate(true);
    Element.prototype.animate = animate;
    const done = raisePortcullis(source, new AbortController().signal, text);
    const frame = document.querySelector<HTMLElement>('.dg-open-frame')!;
    expect([frame.style.top, frame.style.height]).toEqual(['360px', '160px']);
    await done;
    expect(document.querySelector('.dg-open')).toBeNull();
  });

  it('no room above the cover: no chains, the grate still lifts', async () => {
    const cover = addCover();
    source.getBoundingClientRect = () => rect(20, 4, 760, 1400);
    cover.getBoundingClientRect = () => rect(20, 4, 760, 340);
    const { animate } = fakeAnimate(true);
    Element.prototype.animate = animate;
    const done = raisePortcullis(source, new AbortController().signal, text);
    expect(document.querySelectorAll('.dg-open-chain')).toHaveLength(0);
    expect(document.querySelector('.dg-open-grate')).not.toBeNull();
    await done;
  });

  it('abort cancels every animation and removes the overlay at once', async () => {
    addCover();
    const { animate, anims } = fakeAnimate(false);
    Element.prototype.animate = animate;
    const abort = new AbortController();
    const done = raisePortcullis(source, abort.signal, text);
    abort.abort();
    await done;
    expect(document.querySelector('.dg-open')).toBeNull();
    expect(anims.length).toBeGreaterThan(0);
    expect(anims.every((a) => a.cancel.mock.calls.length === 1)).toBe(true);
  });

  it('a cover scrolled out of the window: nothing is animated', async () => {
    const cover = addCover();
    cover.getBoundingClientRect = () => rect(20, -500, 760, 340);
    const { animate } = fakeAnimate(true);
    Element.prototype.animate = animate;
    await raisePortcullis(source, new AbortController().signal, text);
    expect(animate).not.toHaveBeenCalled();
    expect(document.querySelector('.dg-open')).toBeNull();
  });

  it('without Web Animations does nothing', async () => {
    (Element.prototype as { animate?: unknown }).animate = undefined;
    await raisePortcullis(source, new AbortController().signal, text);
    expect(document.querySelector('.dg-open')).toBeNull();
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
