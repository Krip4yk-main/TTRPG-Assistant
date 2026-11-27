import { runEffectStage } from '../../../effect-stage';
import type { ThemeEffect } from '../../../theme.registry';

/**
 * «Голо-ринок»: гру відкрито з картки — «Згортання в проєктор». Сторінка вже показана; над
 * її шапкою (обкладинка й заголовок — `source` до кінця `header.head`, у межах вікна) висить
 * голо-панель з назвою гри: вона сплющується в скан-лінії з рожево-бірюзовим розшаруванням,
 * лінія світла «засмоктується» вниз у шайбу-проєктор, шайба спалахує, і промінь угору
 * розгортає шапку сторінки знизу догори (ціанова лінія розгортки на межі). Шапку ховає й
 * відкриває анімація `clip-path` на `source` (`fill: backwards` — по ефекту стилю немає,
 * переривання повертає як було). Решта сторінки лишається видимою й живою. Разом ≈ 1.15 с.
 * Вигляд — класи `hm-open-*` (`game-opened.less`).
 */

/** Таймінги фаз, мс від початку. */
const T = {
  /** Панель: сплющується (до `SQUASH`), далі лінія летить у шайбу. */
  panel: [0, 420],
  puck: [0, 1150],
  flare: [360, 560],
  beam: [420, 1100],
  reveal: [440, 900],
} as const;
/** Частка `T.panel`, на якій панель уже сплющена в лінію. */
const SQUASH = 0.6;
/** Ширина шайби-проєктора, px. */
const PUCK_W = 90;
/** Найменша висота шапки, на якій ефект має сенс, px. */
const MIN_HEIGHT = 40;
/** Запас `clip-path` збоку й знизу: декор панелей сторінки (рамки, світіння) не обрізається. */
const BLEED = 48;

export const foldIntoProjector: ThemeEffect = async (source, signal) => {
  await runEffectStage(source, signal, 'hm-open', ({ add, play, rect, doc }) => {
    const view = doc.defaultView!;
    const head = source.querySelector('header.head') ?? source;
    // Шапка відносно `source`, лише видима у вікні частина.
    const top = Math.max(0, -rect.top);
    const bottom = Math.min(
      head.getBoundingClientRect().bottom - rect.top,
      view.innerHeight - rect.top,
    );
    const height = bottom - top;
    if (height < MIN_HEIGHT) return;
    const width = rect.width;

    const region = add('hm-open-region');
    Object.assign(region.style, { top: `${top}px`, height: `${height}px` });

    // Голо-панель з назвою гри (як картка, з якої щойно прийшли).
    const panel = add('hm-open-panel', region);
    const title = source.querySelector('h1')?.textContent?.trim();
    if (title) add('hm-open-title', panel).textContent = title;
    add('hm-open-bar', panel);
    add('hm-open-bar hm-open-bar-short', panel);

    const beam = add('hm-open-beam', region);
    beam.style.setProperty('--hm-open-puck', `${PUCK_W}px`);
    const scan = add('hm-open-scan', region);
    const puck = add('hm-open-puck', region);
    puck.style.width = `${PUCK_W}px`;

    // Шапка сторінки схована, доки її не розгорне промінь (знизу догори).
    const shut = `inset(${bottom}px ${-BLEED}px ${-BLEED}px ${-BLEED}px)`;
    const open = `inset(${top > 0 ? top : -BLEED}px ${-BLEED}px ${-BLEED}px ${-BLEED}px)`;
    play(source, [{ clipPath: shut }, { clipPath: open }], T.reveal, 'ease-out', 'backwards');

    // Сплющення в скан-лінії, далі лінія світла летить униз у шайбу й стискається до лінзи.
    const toPuck = height / 2;
    play(
      panel,
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
          transform: `translateY(${toPuck}px) scale(${Math.min(1, PUCK_W / width)}, 0.01)`,
          filter: 'none',
          opacity: 0,
        },
      ],
      T.panel,
      'ease-in',
      'forwards',
    );

    // Шайба: виринає, спалахує, коли в неї влітає лінія, і гасне разом з променем.
    play(
      puck,
      [
        { opacity: 0, transform: 'translate(-50%, 4px)' },
        { opacity: 1, offset: 0.1, transform: 'translate(-50%, 0)' },
        { opacity: 1, offset: 0.8, transform: 'translate(-50%, 0)' },
        { opacity: 0, transform: 'translate(-50%, 0)' },
      ],
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

    // Промінь угору: конус розкривається від шайби, тримається, поки розгортається сторінка.
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
    // Лінія розгортки йде разом з межею `clip-path` (ті самі проміжок і пом'якшення).
    play(
      scan,
      [{ transform: `translateY(${height}px)` }, { transform: 'translateY(0)' }],
      T.reveal,
      'ease-out',
    );
    play(
      scan,
      [{ opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 1, offset: 0.9 }, { opacity: 0 }],
      T.reveal,
      'linear',
    );
  });
};
