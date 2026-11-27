/**
 * Підробний `Element.prototype.animate` для тестів ефектів (Web Animations API у jsdom немає):
 * кожна анімація завершується одразу (`autoFinish`) або коли тест викличе `resolve`; `cancel`
 * відхиляє `finished` з AbortError, як у браузері. `calls` — елемент і кадри кожного виклику.
 */
export interface FakeAnimation {
  target: Element;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  cancel: ReturnType<typeof vi.fn>;
  resolve: () => void;
}

export function fakeAnimate(autoFinish: boolean) {
  const anims: FakeAnimation[] = [];
  const animate = vi.fn(function (
    this: Element,
    frames: Keyframe[],
    options: KeyframeAnimationOptions,
  ) {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const finished = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    finished.catch(() => undefined);
    const a: FakeAnimation & { finished: Promise<void> } = {
      target: this,
      frames,
      options,
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
