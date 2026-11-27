import { runEffectStage, type EffectStage } from '../../../effect-stage';
import type { ThemeEffect } from '../../../theme.registry';

/**
 * «Підземелля»: гру відкрито з картки — «Підйом ґрат». Сторінка вже показана; на обкладинку
 * (`img.cover` у `source`; без обкладинки — шапка `header.head`) з глухим ударом падають
 * залізні ґрати на двох ланцюгах і ривками (три смики) піднімаються під верхній край, з
 * каменю над ними сиплеться пил, наприкінці спалахує світло смолоскипа — прохід відкрито.
 * Сторінку ефект не чіпає (ґрати — в оверлеї, клік крізь них проходить). Разом ≈ 1.5 с.
 * Вигляд — класи `dg-open-*` (`game-opened.less`).
 */

/** Таймінги фаз, мс від початку. */
const T = {
  drop: [0, 320],
  rise: [420, 1250],
  flare: [1150, 1500],
} as const;
/** Тривалість падіння однієї порошини, мс. */
const DUST_MS = 400;
/** Порошин в одному викиді пилу. */
const DUST_PER_BURST = 5;
/** Крок прутів ґрат, px (кількість — за шириною обкладинки). */
const BAR_PITCH = 38;
/** Запас під гострі кінці прутів знизу, px. */
const TIP = 16;
/** Найдовший видимий ланцюг над обкладинкою, px. */
const CHAIN_MAX = 64;
/** Найменша висота обкладинки, на якій ефект має сенс, px. */
const MIN_HEIGHT = 40;
/**
 * Підйом: частки `T.rise` → піднято на частку висоти ґрат. Три смики, після кожного ґрати
 * трохи осідають (провисає ланцюг).
 */
const RISE: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.14, 0.24],
  [0.2, 0.21],
  [0.38, 0.21],
  [0.52, 0.55],
  [0.58, 0.52],
  [0.74, 0.52],
  [1, 1],
];
/** Миті смиків (частки `T.rise`) — у кожну з каменю сиплеться пил. */
const JERKS = [0, 0.38, 0.74];

export const raisePortcullis: ThemeEffect = async (source, signal) => {
  await runEffectStage(source, signal, 'dg-open', (stage) => {
    const { add, play, rect, doc } = stage;
    const view = doc.defaultView!;
    const target = coverOf(source);
    const t = target.getBoundingClientRect();
    // Видима у вікні частина обкладинки, відносно `source`.
    const top = Math.max(t.top, 0) - rect.top;
    const bottom = Math.min(t.bottom, view.innerHeight) - rect.top;
    const height = bottom - top;
    if (height < MIN_HEIGHT || t.width < MIN_HEIGHT) return;
    const left = t.left - rect.left;
    const width = t.width;

    const frame = add('dg-open-frame');
    Object.assign(frame.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
      borderRadius: view.getComputedStyle(target).borderRadius,
    });

    const grate = add('dg-open-grate', frame);
    const count = Math.max(3, Math.round(width / BAR_PITCH));
    for (let i = 0; i < count; i++) {
      add('dg-open-bar', grate).style.left = `${((i + 0.5) / count) * 100}%`;
    }
    for (const at of [0.2, 0.5, 0.8]) add('dg-open-rail', grate).style.top = `${at * 100}%`;

    const travel = height + TIP;
    const lift = (share: number) => `translateY(${-share * travel}px)`;

    // Падіння з глухим ударом (ґрати трохи відскакують), далі три смики вгору.
    play(
      grate,
      [
        { transform: lift(1), easing: 'cubic-bezier(0.55, 0, 1, 0.45)' },
        { transform: lift(0), offset: 0.6, easing: 'ease-out' },
        { transform: 'translateY(-6px)', offset: 0.8, easing: 'ease-in' },
        { transform: lift(0) },
      ],
      T.drop,
      'linear',
      'both',
    );
    // `forwards`: до старту підйому діє падіння (інакше підйом перекрив би його своїм кадром 0).
    play(
      grate,
      RISE.map(([offset, share]) => ({ offset, transform: lift(share) })),
      T.rise,
      'ease-in-out',
      'forwards',
    );

    // Ланцюги: над обкладинкою, ланки біжать разом з ґратами (накручуються на ворот).
    const chainLen = Math.min(CHAIN_MAX, top + rect.top);
    if (chainLen >= 12) {
      for (const x of [0.16, 0.84]) {
        const chain = add('dg-open-chain');
        Object.assign(chain.style, {
          left: `${left + x * width - 6}px`,
          top: `${top - chainLen}px`,
          height: `${chainLen}px`,
        });
        const links = add('dg-open-links', chain);
        links.style.width = `${chainLen}px`;
        // Ланки зсуваються на стільки ж, на скільки піднято ґрати (угору — від'ємний зсув).
        const pos = (share: number) => `${-share * travel}px 0`;
        play(
          links,
          [
            { backgroundPosition: pos(1) },
            { backgroundPosition: pos(0), offset: 0.6 },
            { backgroundPosition: pos(0) },
          ],
          T.drop,
          'linear',
          'both',
        );
        play(
          links,
          RISE.map(([offset, share]) => ({ offset, backgroundPosition: pos(share) })),
          T.rise,
          'ease-in-out',
          'forwards',
        );
        // Брязкіт: ланцюг смикається вбік на кожному ривку.
        play(chain, shake(), T.rise, 'linear', 'none');
      }
    }

    // Пил з каменю над обкладинкою: від удару і на кожному смику.
    const bursts = [T.drop[0] + 190, ...JERKS.map((j) => T.rise[0] + j * span(T.rise))];
    bursts.forEach((at, b) => dust(stage, left, top, width, at, b));

    // Смолоскип спалахує: прохід відкрито.
    const flare = add('dg-open-flare', frame);
    play(
      flare,
      [{ opacity: 0 }, { opacity: 0.6, offset: 0.35 }, { opacity: 0 }],
      T.flare,
      'ease-out',
    );
  });
};

/** Обкладинка гри на сторінці; без неї — шапка (чи весь `source`). */
function coverOf(source: HTMLElement): HTMLElement {
  return (
    source.querySelector<HTMLElement>('img.cover') ??
    source.querySelector<HTMLElement>('header.head') ??
    source
  );
}

function span(range: readonly [number, number]): number {
  return range[1] - range[0];
}

/** Ланцюг здригається вбік на кожному смику (кадри на частках `T.rise`). */
function shake(): Keyframe[] {
  const frames: Keyframe[] = [{ offset: 0, transform: 'translateX(0)' }];
  for (const j of JERKS) {
    frames.push(
      { offset: j + 0.02, transform: 'translateX(-2px)' },
      { offset: j + 0.06, transform: 'translateX(1.5px)' },
      { offset: j + 0.1, transform: 'translateX(0)' },
    );
  }
  frames.push({ offset: 1, transform: 'translateX(0)' });
  return frames;
}

/** Викид пилу `b` у мить `at`: порошини падають з верхнього краю обкладинки й гаснуть. */
function dust(
  { add, play }: EffectStage,
  left: number,
  top: number,
  width: number,
  at: number,
  b: number,
): void {
  for (let i = 0; i < DUST_PER_BURST; i++) {
    // Розкид без випадковості: місця й глибина падіння — від номера викиду й порошини.
    const x = left + width * ((((i * 37 + b * 23) % 97) + 1.5) / 100);
    const fall = 26 + ((i * 17 + b * 11) % 44);
    const drift = ((i + b) % 3) - 1;
    const mote = add('dg-open-dust');
    Object.assign(mote.style, { left: `${x}px`, top: `${top}px` });
    const from = at + i * 30;
    play(
      mote,
      [
        { opacity: 0, transform: 'translate(0, 0)' },
        { opacity: 0.9, offset: 0.2 },
        { opacity: 0, transform: `translate(${drift * 6}px, ${fall}px)` },
      ],
      [from, from + DUST_MS],
      'cubic-bezier(0.4, 0, 1, 1)',
    );
  }
}
