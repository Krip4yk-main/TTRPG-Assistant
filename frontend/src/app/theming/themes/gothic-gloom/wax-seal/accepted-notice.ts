import { runEffectStage } from '../../../effect-stage';
import type { ThemeEffect } from '../../../theme.registry';

/**
 * «Готичний морок»: у сповіщеннях уперше показано «вас прийнято» — «Сургучний вердикт». Рядок
 * сповіщення (`source`) розгортається згори вниз за золотою лінією (`clip-path` на `source`,
 * `fill: backwards` — по ефекту стилю немає, переривання повертає як було); у нижній правий кут
 * падає важка крапля сургучу й розпливається; золотий перстень-печатка тисне її (сургуч
 * сплющується, рядок ледь здригається) і піднімається — лишається відбиток з буквицею
 * (`theme.effects.gothicGloom.seal`), по якому проходить відблиск сусального золота; далі
 * печатка гасне. Клік крізь оверлей проходить. Разом ≈ 1.6 с. Рядок, обрізаний списком панелі
 * (прокручено) чи краєм вікна, не анімується — печатка не лягає поза панеллю.
 * Вигляд — класи `gg-seal-*` (`accepted-notice.less`).
 */

/** Таймінги фаз, мс від початку. */
const T = {
  unfold: [0, 360],
  drop: [300, 620],
  /** Печатка (сургуч і відбиток) видима: з'являється з краплею, наприкінці гасне. */
  seal: [520, 1580],
  spread: [560, 780],
  stamp: [640, 1140],
  press: [840, 1000],
  shudder: [840, 960],
  mark: [960, 1100],
  glint: [1060, 1360],
} as const;
/** Частки `T.stamp`: опустився на сургуч, дотиснув, почав підніматися. */
const STAMP_DOWN = 0.4;
const STAMP_PRESSED = 0.56;
const STAMP_LIFT = 0.64;
/** Розмір печатки, px (за висотою рядка в цих межах). */
const SEAL_MIN = 32;
const SEAL_MAX = 44;
/** Відступ печатки від правого й нижнього країв рядка, px. */
const INSET_RIGHT = 16;
const INSET_BOTTOM = 8;
/** Найменша висота рядка, на якій ефект має сенс, px. */
const MIN_HEIGHT = 40;
/** Звідки (над печаткою) падає крапля й опускається перстень, px. */
const FALL = 72;

export const pressWaxSeal: ThemeEffect = async (source, signal, text) => {
  await runEffectStage(source, signal, 'gg-seal', ({ add, play, rect }) => {
    const { width, height } = rect;
    if (height < MIN_HEIGHT || !rowVisible(source, rect)) return;
    const size = Math.round(Math.min(SEAL_MAX, Math.max(SEAL_MIN, height * 0.55)));
    const left = width - INSET_RIGHT - size;
    const top = height - INSET_BOTTOM - size;
    const place = (el: HTMLElement) =>
      Object.assign(el.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${size}px`,
        height: `${size}px`,
      });

    // Сповіщення розгортається згори вниз; золота лінія йде по межі.
    play(
      source,
      [{ clipPath: `inset(0 0 ${height}px 0)` }, { clipPath: 'inset(0 0 0 0)' }],
      T.unfold,
      'ease-out',
      'backwards',
    );
    const line = add('gg-seal-line');
    play(
      line,
      [
        { transform: 'translateY(0)', opacity: 1 },
        { transform: `translateY(${height}px)`, opacity: 1, offset: 0.85 },
        { transform: `translateY(${height}px)`, opacity: 0 },
      ],
      T.unfold,
      'ease-out',
    );

    // Сургуч на рядку: з'являється з краплею, наприкінці гасне.
    const seal = add('gg-seal-seal');
    place(seal);
    play(
      seal,
      [{ opacity: 0 }, { opacity: 1, offset: 0.06 }, { opacity: 1, offset: 0.78 }, { opacity: 0 }],
      T.seal,
      'linear',
    );
    const wax = add('gg-seal-wax', seal);
    // Крапля розпливається калюжкою…
    play(
      wax,
      [
        { transform: 'scale(0.25, 0.2)' },
        { transform: 'scale(0.82, 0.7)', offset: 0.6 },
        { transform: 'scale(0.78, 0.74)' },
      ],
      T.spread,
      'ease-out',
      'both',
    );
    // …перстень її сплющує, сургуч трохи вилазить з-під нього й осідає.
    play(
      wax,
      [
        { transform: 'scale(0.78, 0.74)' },
        { transform: 'scale(1.08, 1.04)', offset: 0.45 },
        { transform: 'scale(1)' },
      ],
      T.press,
      'ease-out',
      'forwards',
    );

    // Відбиток: поглиблене кільце з буквицею — видно, щойно перстень піднявся.
    const mark = add('gg-seal-mark', wax);
    add('gg-seal-letter', mark, 'span').textContent = text('theme.effects.gothicGloom.seal');
    play(mark, [{ opacity: 0 }, { opacity: 1 }], T.mark, 'ease-out');
    // Відблиск сусального золота проходить по відбитку.
    const glint = add('gg-seal-glint', mark);
    play(
      glint,
      [{ transform: 'translateX(-120%)' }, { transform: 'translateX(120%)' }],
      T.glint,
      'ease-in-out',
    );

    // Крапля падає згори у кут і розпливається (стає сургучем).
    const drop = add('gg-seal-drop');
    Object.assign(drop.style, { left: `${left + size / 2}px`, top: `${top + size / 2}px` });
    play(
      drop,
      [
        { transform: `translateY(${-FALL}px) scale(0.8, 1.1)`, opacity: 0 },
        { opacity: 1, offset: 0.15 },
        {
          transform: 'translateY(0) scale(1, 1.15)',
          opacity: 1,
          offset: 0.7,
          easing: 'ease-out',
        },
        { transform: 'translateY(0) scale(1.9, 0.45)', opacity: 0 },
      ],
      T.drop,
      'cubic-bezier(0.55, 0, 1, 0.45)',
    );

    // Золотий перстень опускається, тисне і йде вгору.
    const stamp = add('gg-seal-stamp');
    place(stamp);
    for (const part of ['handle', 'knob', 'face']) add(`gg-seal-${part}`, stamp);
    play(
      stamp,
      [
        { transform: `translateY(${-FALL}px) scale(1.15)`, opacity: 0 },
        {
          transform: 'translateY(0) scale(1)',
          opacity: 1,
          offset: STAMP_DOWN,
          easing: 'ease-in',
        },
        { transform: 'translateY(2px) scale(0.94)', opacity: 1, offset: STAMP_PRESSED },
        { transform: 'translateY(0) scale(1)', opacity: 1, offset: STAMP_LIFT, easing: 'ease-in' },
        { transform: `translateY(${-FALL * 0.7}px) scale(1.1)`, opacity: 0 },
      ],
      T.stamp,
      'ease-out',
    );

    // Сторінка ледь здригається від удару (лише під час удару; по ньому — як була).
    play(
      source,
      [
        { transform: 'translateY(0)' },
        { transform: 'translateY(1.5px)', offset: 0.3 },
        { transform: 'translateY(-0.5px)', offset: 0.65 },
        { transform: 'translateY(0)' },
      ],
      T.shudder,
      'ease-out',
      'none',
    );
  });
};

/**
 * Рядок видно: не обрізаний жодним предком з прокруткою чи `overflow` (список панелі
 * сповіщень), по висоті — у вікні, і правий край (де печатка) не за вікном. Лівий край вікно
 * може зрізати (вузький екран: панель ширша за місце ліворуч від дзвіночка).
 */
function rowVisible(source: HTMLElement, rect: DOMRect): boolean {
  const view = source.ownerDocument.defaultView!;
  const inside = (r: { top: number; bottom: number; left: number; right: number }) =>
    rect.top >= r.top - 1 &&
    rect.bottom <= r.bottom + 1 &&
    rect.left >= r.left - 1 &&
    rect.right <= r.right + 1;
  const viewport = { top: 0, left: -Infinity, bottom: view.innerHeight, right: view.innerWidth };
  if (!inside(viewport)) return false;
  for (let el = source.parentElement; el; el = el.parentElement) {
    const { overflowX, overflowY } = view.getComputedStyle(el);
    if (overflowX === 'visible' && overflowY === 'visible') continue;
    if (!inside(el.getBoundingClientRect())) return false;
  }
  return true;
}
