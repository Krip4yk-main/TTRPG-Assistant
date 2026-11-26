import type { ThemeEffect } from '../../../theme.registry';

/**
 * «Магіпанк»: надіслана заявка складається втричі, лягає в конверт, конверт запечатується
 * сливовим сургучем і відлітає за правий верхній край екрана, лишаючи слід чарівного пилу
 * (бірюза й золото). Декоративний оверлей (`aria-hidden`, `inert`, без подій миші; у top
 * layer, як і діалоги CDK) поверх діалогу: аркуш — копія вигляду `source` (значення полів і прокрутка — як в оригіналі), сам
 * `source` ховається (далі його прибирає викликач). Рух — Web Animations API, вигляд —
 * класи `mp-send-*` у бандлі дизайну (`application-sent.less`). Разом ≈ 1.6 с; пил догорає
 * ще ≤ `DUST_MS` уже після завершення промісу. Переривання (`signal`) — оверлей зникає одразу.
 */

/** Таймінги фаз, мс від початку. */
const T = {
  foldBottom: [0, 260],
  foldTop: [180, 440],
  pocket: [440, 720],
  flap: [640, 860],
  seal: [860, 1040],
  flight: [1060, 1600],
} as const;
/** Скільки живе одна порошинка. */
export const DUST_MS = 600;
/** Найбільша ширина конверта (ширша форма зменшується до неї). */
const ENVELOPE_MAX_W = 360;
const DUST_COLORS = ['#6fe6d2', '#bff7ee', '#f0c36a', '#f7dc9a'];

export const sendInEnvelope: ThemeEffect = async (source, signal) => {
  const doc = source.ownerDocument;
  const win = doc.defaultView;
  if (!win || typeof source.animate !== 'function' || signal.aborted) return;
  const rect = source.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  const w = rect.width;
  const h = rect.height;
  const third = h / 3;

  const overlay = div(doc, 'mp-send');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.inert = true;
  const flight = div(doc, 'mp-send-flight');
  Object.assign(flight.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${w}px`,
    height: `${h}px`,
  });

  // Три смуги аркуша: лице — копія форми зі зсувом, звороть — пергамент.
  const panels = [0, 1, 2].map((i) => {
    const panel = div(doc, `mp-send-panel mp-send-panel-${i}`);
    Object.assign(panel.style, { top: `${i * third}px`, height: `${third}px` });
    const front = div(doc, 'mp-send-face mp-send-front');
    const sheet = copyVisual(source, w, h);
    sheet.style.top = `${-i * third}px`;
    front.append(sheet);
    panel.append(front, div(doc, 'mp-send-face mp-send-back'));
    return panel;
  });

  const envelope = div(doc, 'mp-send-envelope');
  Object.assign(envelope.style, { top: `${third}px`, height: `${third}px` });
  const pocket = div(doc, 'mp-send-pocket');
  const flap = div(doc, 'mp-send-flap');
  const seal = div(doc, 'mp-send-seal');
  envelope.append(pocket, flap, seal);

  flight.append(...panels, envelope);
  overlay.append(flight);
  doc.body.append(overlay);
  // Оверлеї CDK живуть у top layer (popover) — оверлей ефекту теж, інакше він опиниться під
  // діалогом і його тлом.
  if (typeof overlay.showPopover === 'function') {
    overlay.setAttribute('popover', 'manual');
    overlay.showPopover();
  }
  syncState(source, overlay);
  source.style.visibility = 'hidden';

  const anims: Animation[] = [];
  let cancelled = false;
  let dustFrame = 0;
  const cancel = () => {
    cancelled = true;
    if (dustFrame) win.cancelAnimationFrame?.(dustFrame);
    anims.forEach((a) => a.cancel());
    overlay.remove();
  };
  signal.addEventListener('abort', cancel, { once: true });

  const play = (
    el: HTMLElement,
    frames: Keyframe[],
    [from, to]: readonly [number, number],
    easing = 'ease-in-out',
    fill: FillMode = 'both',
  ): Animation => {
    const a = el.animate(frames, { delay: from, duration: to - from, easing, fill });
    anims.push(a);
    return a;
  };

  const s = Math.min(1, ENVELOPE_MAX_W / w);
  flight.style.setProperty('--mp-send-k', String(1 / s));
  const cx = rect.left + w / 2;
  const cy = rect.top + h / 2;
  const tx = win.innerWidth - cx + (w * s) / 2 + 80;
  const ty = -(cy + third * s + 80);

  // Складання: нижня третина — вгору, верхня — донизу поверх неї.
  play(
    panels[2]!,
    [{ transform: 'rotateX(0deg)' }, { transform: 'rotateX(180deg)' }],
    T.foldBottom,
  );
  play(panels[0]!, [{ transform: 'rotateX(0deg)' }, { transform: 'rotateX(-180deg)' }], T.foldTop);
  // Конверт: зменшення до розміру конверта, кишеня наїжджає знизу, клапан закривається.
  play(flight, [{ transform: 'scale(1)' }, { transform: `scale(${s})` }], T.pocket);
  play(
    pocket,
    [
      { opacity: 0, transform: 'translateY(35%)' },
      { opacity: 1, transform: 'translateY(0)' },
    ],
    T.pocket,
    'ease-out',
  );
  play(
    flap,
    [
      { opacity: 0, transform: 'rotateX(180deg)' },
      { opacity: 1, offset: 0.15, transform: 'rotateX(160deg)' },
      { opacity: 1, transform: 'rotateX(0deg)' },
    ],
    T.flap,
  );
  // Печатка: падає й «вдавлюється» в сургуч.
  play(
    seal,
    [
      { opacity: 0, transform: 'translate(-50%, -50%) scale(2.4) rotate(-30deg)' },
      { opacity: 1, offset: 0.6, transform: 'translate(-50%, -50%) scale(0.92) rotate(0deg)' },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1) rotate(0deg)' },
    ],
    T.seal,
    'ease-out',
  );
  // Політ: замах і відліт за правий верхній край. Без заповнення назад — до старту діє
  // зменшення вище.
  const fly = play(
    flight,
    [
      { transform: `translate(0, 0) scale(${s}) rotate(0deg)` },
      { offset: 0.2, transform: `translate(-18px, 14px) scale(${s * 1.04}) rotate(5deg)` },
      { transform: `translate(${tx}px, ${ty}px) scale(${s * 0.35}) rotate(-24deg)` },
    ],
    T.flight,
    'ease-in',
    'forwards',
  );

  // Пил: щокадру — порошинки там, де зараз конверт.
  const raf = win.requestAnimationFrame?.bind(win);
  const dustStart = performance.now() + T.flight[0];
  const spawn = () => {
    if (cancelled) return;
    if (performance.now() >= dustStart) {
      const box = envelope.getBoundingClientRect();
      for (let k = 0; k < 2; k++) dust(doc, overlay, box, anims);
    }
    dustFrame = raf!(spawn);
  };
  if (raf) dustFrame = raf(spawn);

  try {
    await fly.finished;
  } catch {
    // Перервано (`cancel`).
  } finally {
    signal.removeEventListener('abort', cancel);
    if (dustFrame) win.cancelAnimationFrame?.(dustFrame);
    dustFrame = 0;
  }
  if (cancelled) return;
  cancelled = true; // нових порошинок не буде
  envelope.style.visibility = 'hidden';
  panels.forEach((p) => (p.style.visibility = 'hidden'));
  win.setTimeout(() => overlay.remove(), DUST_MS + 50);
};

function div(doc: Document, className: string): HTMLDivElement {
  const el = doc.createElement('div');
  el.className = className;
  return el;
}

/**
 * Копія вигляду `source` розміром `w`×`h`. Стилі Material часто залежать від предків
 * (`.mat-mdc-dialog-container .x`), тож копію загорнуто в «оболонки» з класами всіх предків
 * аж до `<body>` — без їхньої розкладки (inline-стилі гасять позиціювання й розміри).
 */
function copyVisual(source: HTMLElement, w: number, h: number): HTMLElement {
  const doc = source.ownerDocument;
  const clone = source.cloneNode(true) as HTMLElement;
  clone.removeAttribute('id');
  clone.setAttribute('data-mp-send-copy', '');
  clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  clone.style.cssText += `;visibility:visible;margin:0;width:${w}px;height:${h}px;max-width:none;max-height:none;transform:none;`;
  let inner: HTMLElement = clone;
  for (let a = source.parentElement; a && a !== doc.body; a = a.parentElement) {
    const shell = doc.createElement('div');
    shell.className = a.className;
    shell.style.cssText =
      'position:static;display:block;width:auto;height:auto;margin:0;padding:0;border:0;' +
      'transform:none;max-width:none;max-height:none;min-width:0;min-height:0;' +
      'background:none;box-shadow:none;pointer-events:none;overflow:visible;z-index:auto;';
    shell.append(inner);
    inner = shell;
  }
  const sheet = doc.createElement('div');
  sheet.className = 'mp-send-sheet';
  Object.assign(sheet.style, { width: `${w}px`, height: `${h}px` });
  sheet.append(inner);
  return sheet;
}

/**
 * Значення полів і прокрутка — як в оригіналі (`cloneNode` їх не переносить). Кожна копія в
 * оверлеї має ту саму структуру, що й `source`, тож елементи зіставляються за порядком.
 */
function syncState(source: HTMLElement, overlay: HTMLElement): void {
  const fields = Array.from(source.querySelectorAll<HTMLInputElement>('input, textarea, select'));
  const scrolled = [source, ...Array.from(source.querySelectorAll<HTMLElement>('*'))]
    .map((el, i) => [el, i] as const)
    .filter(([el]) => el.scrollTop > 0 || el.scrollLeft > 0);
  overlay.querySelectorAll<HTMLElement>('.mp-send-sheet').forEach((sheet) => {
    const root = sheet.querySelector<HTMLElement>('[data-mp-send-copy]');
    if (!root) return;
    root.querySelectorAll<HTMLInputElement>('input, textarea, select').forEach((el, i) => {
      const src = fields[i];
      if (!src) return;
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = src.checked;
      else el.value = src.value;
    });
    if (scrolled.length === 0) return;
    const all = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
    for (const [el, i] of scrolled) {
      const c = all[i];
      if (c) {
        c.scrollTop = el.scrollTop;
        c.scrollLeft = el.scrollLeft;
      }
    }
  });
}

/** Порошинка біля конверта: спалахує й осідає, згасаючи. */
function dust(doc: Document, overlay: HTMLElement, box: DOMRect, anims: Animation[]): void {
  const d = doc.createElement('i');
  d.className = 'mp-send-dust';
  const size = 2 + Math.random() * 4;
  const color = DUST_COLORS[Math.floor(Math.random() * DUST_COLORS.length)]!;
  const x = box.left + box.width * (0.25 + Math.random() * 0.5);
  const y = box.top + box.height * (0.3 + Math.random() * 0.6);
  Object.assign(d.style, {
    left: `${x}px`,
    top: `${y}px`,
    width: `${size}px`,
    height: `${size}px`,
    background: color,
    color,
  });
  overlay.append(d);
  const dx = (Math.random() - 0.5) * 40;
  const dy = 10 + Math.random() * 30;
  const a = d.animate(
    [
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1)' },
      { opacity: 0, transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.2)` },
    ],
    { duration: DUST_MS * (0.6 + Math.random() * 0.4), easing: 'ease-out', fill: 'forwards' },
  );
  anims.push(a);
  a.finished.then(
    () => d.remove(),
    () => d.remove(),
  );
}
