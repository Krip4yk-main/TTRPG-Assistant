import { runEffectStage } from '../../../effect-stage';
import type { ThemeEffect } from '../../../theme.registry';

/**
 * «Голо-ринок»: гру відкривають з картки — «Згортання в проєктор». Грає на самій картці
 * (`source` — хост картки), сторінка гри відкривається лише після нього. Голо-панель картки
 * сплющується в скан-лінію з рожево-бірюзовим розшаруванням, лінія світла «засмоктується» вниз
 * у шайбу-проєктор під карткою (`.sc-d3`), шайба спалахує, і промінь угору з лінією розгортки
 * «відправляє» гру далі — тут відкривається сторінка. Шайба картки лишається на місці (її ефект
 * не чіпає); решта картки — анімацією (`fill: forwards`, згорнута до переходу; картка знімає це
 * сама, якщо пережила перехід). Разом ≈ 1.4 с. Вигляд — класи `hm-open-*` (`game-opened.less`).
 */

/** Таймінги фаз, мс від початку. */
const T = {
  /** Картка: сплющується (до `SQUASH`), далі лінія летить у шайбу. */
  fold: [0, 640],
  puck: [0, 1400],
  flare: [560, 820],
  beam: [640, 1400],
  scan: [680, 1300],
} as const;
/** Частка `T.fold`, на якій картка вже сплющена в лінію. */
const SQUASH = 0.6;
/** Ширина шайби-проєктора, px (як `.sc-d3` у бандлі дизайну). */
const PUCK_W = 90;
/** Від низу картки до верху шайби, px (`.sc-d3`: `bottom: -32px`, висота 10px). */
const PUCK_GAP = 22;
/** Найменша висота картки, на якій ефект має сенс, px. */
const MIN_HEIGHT = 40;

export const foldIntoProjector: ThemeEffect = async (source, signal) => {
  await runEffectStage(source, signal, 'hm-open', ({ add, play, rect }) => {
    const { height } = rect;
    if (height < MIN_HEIGHT) return;
    // Частини картки, що згортаються, — усе, крім самої шайби.
    const parts = Array.from(source.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && !el.classList.contains('sc-d3'),
    );
    if (parts.length === 0) return;

    // Область — від верху картки до верху шайби.
    const region = add('hm-open-region');
    region.style.bottom = `${-PUCK_GAP}px`;
    const regionH = height + PUCK_GAP;
    const beam = add('hm-open-beam', region);
    beam.style.setProperty('--hm-open-puck', `${PUCK_W}px`);
    const scan = add('hm-open-scan', region);
    const puck = add('hm-open-puck', region);
    puck.style.width = `${PUCK_W}px`;

    // Сплющення в скан-лінію, далі лінія світла летить униз у шайбу й стискається до лінзи.
    const lens = rect.bottom + PUCK_GAP;
    for (const part of parts) {
      const r = part.getBoundingClientRect();
      const toPuck = lens - (r.top + r.height / 2);
      const narrow = Math.min(1, PUCK_W / Math.max(r.width, 1));
      play(
        part,
        [
          { transform: 'translateY(0) scale(1, 1)', filter: 'none', opacity: 1 },
          {
            offset: SQUASH * 0.5,
            transform: 'translateY(0) scale(1, 0.35)',
            filter: 'drop-shadow(-4px 0 0 #ff5cb4) drop-shadow(4px 0 0 #5ef2ff)',
            opacity: 1,
          },
          {
            offset: SQUASH,
            transform: 'translateY(0) scale(1, 0.02)',
            filter: 'drop-shadow(-3px 0 0 #ff5cb4) drop-shadow(3px 0 0 #5ef2ff)',
            opacity: 1,
          },
          {
            transform: `translateY(${toPuck}px) scale(${narrow}, 0.01)`,
            filter: 'none',
            opacity: 0,
          },
        ],
        T.fold,
        'ease-in',
        'forwards',
      );
    }

    // Шайба: світиться, спалахує, коли в неї влітає лінія, і гасне разом з променем.
    play(
      puck,
      [{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }],
      T.puck,
      'ease-out',
    );
    play(
      puck,
      [
        { boxShadow: '0 2px 6px #000' },
        { boxShadow: '0 0 18px 6px rgba(94, 242, 255, 0.85), 0 2px 6px #000', offset: 0.35 },
        { boxShadow: '0 0 8px 2px rgba(94, 242, 255, 0.45), 0 2px 6px #000' },
      ],
      T.flare,
      'ease-out',
      'none',
    );

    // Промінь угору: конус розкривається від шайби на місці картки й гасне.
    play(
      beam,
      [
        { opacity: 0, transform: 'scaleY(0)' },
        { opacity: 1, offset: 0.2, transform: 'scaleY(1)' },
        { opacity: 0.8, offset: 0.7, transform: 'scaleY(1)' },
        { opacity: 0, transform: 'scaleY(1)' },
      ],
      T.beam,
      'ease-out',
    );
    // Лінія розгортки біжить від шайби вгору по променю.
    play(
      scan,
      [{ transform: `translateY(${regionH}px)` }, { transform: 'translateY(0)' }],
      T.scan,
      'ease-out',
    );
    play(
      scan,
      [{ opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }],
      T.scan,
      'linear',
    );
  });
};
