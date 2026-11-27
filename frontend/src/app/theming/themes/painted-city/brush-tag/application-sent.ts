import { runEffectStage } from '../../../effect-stage';
import type { ThemeEffect } from '../../../theme.registry';

/**
 * «Мальоване місто»: заявку подано — «Тег пензлем». Поверх діалогу-афіші пензель виписує
 * рожевий тег «Я в грі!» (uk.json `theme.effects.paintedCity.tag`) мазок за мазком: літера за
 * літерою, на пробілах пензель відривається від стіни; з двох літер стікають патьоки й
 * застигають, знизу лягає бірюзовий підкреслювальний мазок із бризками. Далі тег тихо зникає,
 * діалог закриває викликач. Сам діалог ефект не чіпає. Разом ≤ 1.6 с від успіху: до 0.1 с
 * чекання шрифту й 1.5 с мазків. Вигляд — класи `pc-send-*`
 * (`application-sent.less`), шрифт — графіті Rubik Wet Paint дизайну.
 */

/** Таймінги фаз, мс від старту сцени (після чекання шрифту, `FONT_WAIT_MS`). */
const T = {
  brushIn: [0, 100],
  write: [80, 850],
  brushOut: [850, 1010],
  drips: [0, 1220],
  swoosh: [940, 1160],
  splatter: [1120, 1240],
  out: [1320, 1500],
} as const;
/** Шрифт тегу (той самий, що графіті в шапці дизайну). */
const TAG_FONT = "'Rubik Wet Paint'";
/** Кегль тегу, px: межі й орієнтовна ширина літери (em). */
const FONT = { min: 28, max: 76, em: 0.62 } as const;
/** Найширший тег, px (у вужчому діалозі — на його ширину без полів). */
const MAX_TAG_W = 440;
/** Патьоки — з першої літери й з тієї, що на ≈ 4/5 тегу (у «Я в грі!» — «Я» та «і»). */
const DRIP_AT = [0, 0.8] as const;
const SPLATTER = 3;

/**
 * Найдовше чекання шрифту перед мазком, мс (далі — малюємо запасним). Разом зі сценою
 * (`T.out[1]`) — не довше 1.6 с від успіху.
 */
const FONT_WAIT_MS = 100;
/**
 * Зразок гліфів для попереднього завантаження: грані шрифту розділено за unicode-range
 * (кирилиця й латиниця — окремі файли), без зразка `fonts.load` бере лише латинську.
 */
const PRELOAD_SAMPLE = 'ЯяAa';

// Шрифт графіті вантажимо, щойно чанк ефекту підтягнуто (діалог заявки робить це заздалегідь),
// щоб до мазка він уже був і літери міряли справжньою гарнітурою.
if (typeof document !== 'undefined') {
  document.fonts?.load(`400 1em ${TAG_FONT}`, PRELOAD_SAMPLE).catch(() => undefined);
}

/**
 * Дочекатися граней шрифту тегу для саме цього напису (зразок — `caption`), але не довше
 * `FONT_WAIT_MS`: шрифт не встиг — міряємо й малюємо запасним, ефект не затримується.
 */
async function tagFontReady(doc: Document, caption: string): Promise<void> {
  const fonts = doc.fonts as FontFaceSet | undefined;
  if (typeof fonts?.load !== 'function') return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    fonts.load(`400 1em ${TAG_FONT}`, caption).catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FONT_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
}

export const paintBrushTag: ThemeEffect = async (source, signal, text) => {
  const caption = text('theme.effects.paintedCity.tag').trim();
  // Літери міряємо після шрифту (переривання за час чекання — сцена й не відкриється).
  await tagFontReady(source.ownerDocument, caption);
  await runEffectStage(source, signal, 'pc-send', ({ add, play, rect }) => {
    const chars = [...caption];
    const maxW = Math.min(MAX_TAG_W, rect.width - 48);
    let font = Math.round(
      Math.max(FONT.min, Math.min(FONT.max, maxW / (Math.max(1, chars.length) * FONT.em))),
    );

    const tag = add('pc-send-tag');
    const line = add('pc-send-text', tag);
    line.style.fontSize = `${font}px`;
    const letters = chars.map((ch) => {
      const letter = add(/\s/.test(ch) ? 'pc-send-gap' : 'pc-send-letter', line, 'span');
      letter.textContent = ch;
      return letter;
    });
    // Ширший за діалог (шрифт ширший за оцінку) — зменшуємо кегль.
    if (line.offsetWidth > maxW) {
      font = Math.max(FONT.min, Math.floor((font * maxW) / line.offsetWidth));
      line.style.fontSize = `${font}px`;
    }
    const lineW = line.offsetWidth;
    const lineH = line.offsetHeight || font;
    const boxes = letters.map((l) => ({ left: l.offsetLeft, width: l.offsetWidth }));

    // Час на літеру — пропорційно ширині (пензель іде рівно); без розкладки — порівну.
    const total = boxes.reduce((sum, b) => sum + b.width, 0);
    const weights = boxes.map((b) => (total > 0 ? b.width / total : 1 / boxes.length));
    const [w0, w1] = T.write;
    let acc = 0;
    const spans = weights.map((wt) => {
      const from = w0 + Math.round(acc * (w1 - w0));
      acc += wt;
      return [from, w0 + Math.round(acc * (w1 - w0))] as const;
    });

    // Мазок: літера проявляється зліва направо (тінь-контур — з запасом за межі літери).
    letters.forEach((letter, i) => {
      if (letter.className === 'pc-send-gap') return;
      play(
        letter,
        [{ clipPath: 'inset(-40% 110% -40% -10%)' }, { clipPath: 'inset(-40% -20% -40% -10%)' }],
        spans[i],
        'ease-in-out',
      );
    });

    // Пензель: кінчик іде по літерах, на пробілах — відрив від стіни; потім відлітає.
    const brush = add('pc-send-brush', tag);
    brush.style.top = `${Math.round(lineH * 0.55)}px`;
    const at = (x: number, lift = 0) => `translate(${Math.round(x)}px, ${lift}px) rotate(-40deg)`;
    const path: Keyframe[] = [];
    boxes.forEach((b, i) => {
      const gap = letters[i].className === 'pc-send-gap';
      const [from, to] = spans[i];
      const offset = (t: number) => (t - w0) / (w1 - w0);
      path.push({ offset: offset(from), transform: at(b.left, gap ? -4 : 0) });
      if (gap) path.push({ offset: (offset(from) + offset(to)) / 2, transform: at(b.left, -14) });
      path.push({ offset: offset(to), transform: at(b.left + b.width, gap ? -4 : 0) });
    });
    play(brush, [{ opacity: 0 }, { opacity: 1 }], T.brushIn, 'ease-out');
    play(brush, path, T.write, 'linear');
    play(
      brush,
      [
        { opacity: 1, transform: at(lineW) },
        { opacity: 0, transform: `translate(${Math.round(lineW + 40)}px, -36px) rotate(-55deg)` },
      ],
      T.brushOut,
      'ease-in',
      'forwards',
    );

    // Патьоки: стікають щойно літеру написано, сповільнюються й застигають.
    const painted = letters.flatMap((l, i) => (l.className === 'pc-send-letter' ? [i] : []));
    const dripIdx = [...new Set(DRIP_AT.map((k) => painted[Math.floor(k * (painted.length - 1))]))];
    for (const i of dripIdx) {
      if (i === undefined) continue;
      const drip = add('pc-send-drip', tag);
      Object.assign(drip.style, {
        left: `${Math.round(boxes[i].left + boxes[i].width * 0.42)}px`,
        top: `${Math.round(lineH * 0.78)}px`,
        height: `${Math.round(font * 0.6)}px`,
      });
      const start = spans[i][1] + 60;
      play(
        drip,
        [
          { transform: 'scaleY(0)' },
          { offset: 0.45, transform: 'scaleY(0.55)' },
          { transform: 'scaleY(1)' },
        ],
        [start, T.drips[1]],
        'cubic-bezier(.2,.7,.4,1)',
      );
    }

    // Бірюзовий підкреслювальний мазок і бризки на його кінці.
    const swoosh = add('pc-send-swoosh', tag);
    Object.assign(swoosh.style, { top: `${Math.round(lineH * 0.92)}px`, width: `${lineW + 24}px` });
    play(
      swoosh,
      [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }],
      T.swoosh,
      'ease-out',
    );
    for (let k = 0; k < SPLATTER; k++) {
      const dot = add(`pc-send-splat pc-send-splat-${k + 1}`, tag);
      Object.assign(dot.style, {
        left: `${lineW + 18 + k * 7}px`,
        top: `${Math.round(lineH * 0.92) - 2 - k * 7}px`,
      });
      play(
        dot,
        [
          { transform: 'scale(0)' },
          { offset: 0.6, transform: 'scale(1.3)' },
          { transform: 'scale(1)' },
        ],
        [T.splatter[0] + k * 30, T.splatter[1]],
        'ease-out',
      );
    }

    play(tag, [{ opacity: 1 }, { opacity: 0 }], T.out, 'ease-in', 'forwards');
  });
};
