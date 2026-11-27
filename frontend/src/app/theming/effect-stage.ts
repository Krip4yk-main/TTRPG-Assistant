/**
 * Сцена фірмового ефекту дизайну: декоративний оверлей (`aria-hidden`, `inert`, без подій
 * миші) на весь екран у top layer (popover — як оверлеї CDK, інакше він опиниться під діалогом)
 * і в ньому `box` — прямокутник точно над `source`. Ефект додає в `box` свої елементи й рухає їх
 * через `play` (Web Animations API), а `finish` чекає кінця всіх анімацій і прибирає оверлей.
 * Переривання (`signal`) — усі анімації скасовуються (і на `source` теж: він знову як був),
 * оверлей зникає одразу. Розкладку сторінки сцена не чіпає (лише `position: fixed`).
 */
export interface EffectStage {
  readonly doc: Document;
  /** Прямокутник `source` на момент старту. */
  readonly rect: DOMRect;
  /** Оверлей на весь екран. */
  readonly root: HTMLDivElement;
  /** Прямокутник над `source` (координати елементів ефекту — відносно нього). */
  readonly box: HTMLDivElement;
  /** Новий елемент з класом у `parent` (за замовчуванням — у `box`). */
  add(className: string, parent?: HTMLElement, tag?: string): HTMLElement;
  /** Анімація елемента в проміжку `[from, to]` мс від старту ефекту. */
  play(
    el: Element,
    frames: Keyframe[],
    span: readonly [number, number],
    easing?: string,
    fill?: FillMode,
  ): Animation;
  /** Дочекатися всіх анімацій (чи переривання) і прибрати оверлей. */
  finish(): Promise<void>;
}

/**
 * Відкрити сцену над `source`. `null` — ефекту не буде: немає Web Animations API, `source`
 * без розміру або вже перервано.
 */
export function openEffectStage(
  source: HTMLElement,
  signal: AbortSignal,
  className: string,
): EffectStage | null {
  const doc = source.ownerDocument;
  if (!doc.defaultView || typeof source.animate !== 'function' || signal.aborted) return null;
  const rect = source.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return null;

  const root = doc.createElement('div');
  root.className = className;
  root.setAttribute('aria-hidden', 'true');
  root.inert = true;
  // Скидаємо UA-стилі popover: оверлей — увесь екран, прозорий, без подій миші.
  root.style.cssText =
    'position:fixed;inset:0;z-index:1100;width:auto;height:auto;max-width:none;' +
    'max-height:none;margin:0;padding:0;border:0;overflow:hidden;background:none;' +
    'color:inherit;pointer-events:none;';
  const box = doc.createElement('div');
  box.style.cssText =
    `position:absolute;left:${rect.left}px;top:${rect.top}px;` +
    `width:${rect.width}px;height:${rect.height}px;`;
  root.append(box);
  doc.body.append(root);
  if (typeof root.showPopover === 'function') {
    root.setAttribute('popover', 'manual');
    root.showPopover();
  }

  const anims: Animation[] = [];
  const cancel = () => anims.forEach((a) => a.cancel());

  return {
    doc,
    rect,
    root,
    box,
    add(cls, parent = box, tag = 'div') {
      const el = doc.createElement(tag);
      el.className = cls;
      parent.append(el);
      return el;
    },
    play(el, frames, [from, to], easing = 'ease-in-out', fill = 'both') {
      const a = el.animate(frames, { delay: from, duration: to - from, easing, fill });
      anims.push(a);
      return a;
    },
    async finish() {
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
      try {
        await Promise.all(anims.map((a) => a.finished));
      } catch {
        // Перервано (`cancel`).
      } finally {
        signal.removeEventListener('abort', cancel);
        root.remove();
      }
    },
  };
}
