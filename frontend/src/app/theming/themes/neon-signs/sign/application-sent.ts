import { runEffectStage } from '../../../effect-stage';
import type { ThemeEffect } from '../../../theme.registry';

/**
 * «Неонові вивіски»: заявку подано — діалог гасне, на його місці над темною стіною висить
 * вивіска «ЗАЯВКУ ПОДАНО» (uk.json `theme.effects.neonSigns.sign`, слово — рядок). Холодні
 * скляні трубки спалахують зліва направо, кожна літера з коротким «клац»; одна трубка
 * заїкається двічі (характер старої вивіски); знизу вмикається ціанова трубка, на мокрому
 * асфальті — розмитий відблиск, у кутку — зелена галочка. Далі вивіска тихо гасне, діалог
 * закриває викликач. Разом ≈ 1.55 с. Вигляд — класи `ns-send-*` (`application-sent.less`).
 */

/** Таймінги фаз, мс від початку. */
const T = {
  dialogOut: [0, 200],
  signIn: [60, 240],
  letters: [220, 760],
  stutter: [760, 1060],
  tube: [700, 840],
  glow: [220, 900],
  reflection: [820, 1080],
  check: [1000, 1140],
  out: [1300, 1550],
} as const;
/** Одна літера: «клац» — спалах, мить темряви, світло. */
const LETTER_MS = 120;
/** Найбільший кегль літер вивіски, px. */
const MAX_FONT = 48;
/** Найширша вивіска, px (у вужчому діалозі — на його ширину). */
const MAX_SIGN_W = 440;

// Кольори трубок — токени дизайну (`neon-signs.less`): рожевий неон і його серцевина.
const COLD: Keyframe = {
  color: 'rgba(255, 227, 243, 0.06)',
  textShadow: '0 0 0 rgba(255, 63, 164, 0)',
};
const LIT: Keyframe = {
  color: '#ffe3f3',
  textShadow: '0 0 4px #ff3fa4, 0 0 12px #ff3fa4, 0 0 26px #ff3fa4',
};

export const lightNeonSign: ThemeEffect = async (source, signal, text) => {
  await runEffectStage(source, signal, 'ns-send', ({ add, play, rect }) => {
    const words = text('theme.effects.neonSigns.sign').trim().split(/\s+/).filter(Boolean);
    const longest = Math.max(1, ...words.map((w) => w.length));
    const signW = Math.min(MAX_SIGN_W, rect.width - 16);
    // Літера M PLUS Rounded з розрядкою ≈ 0.86em завширшки.
    const font = Math.max(20, Math.min(MAX_FONT, Math.floor(signW / (longest * 0.86))));

    const sign = add('ns-send-sign');
    Object.assign(sign.style, { width: `${signW}px`, fontSize: `${font}px` });
    const glow = add('ns-send-glow', sign);
    add('ns-send-wire ns-send-wire-l', sign);
    add('ns-send-wire ns-send-wire-r', sign);
    const lines = add('ns-send-lines', sign);
    const letters: HTMLElement[] = [];
    for (const word of words) {
      const line = add('ns-send-line', lines);
      for (const ch of word) {
        const letter = add('ns-send-letter', line, 'span');
        letter.textContent = ch;
        letters.push(letter);
      }
    }
    const tube = add('ns-send-tube', sign);
    const reflection = add('ns-send-reflection', sign);
    for (const word of words) add('ns-send-line', reflection).textContent = word;
    const check = add('ns-send-check', sign);
    check.textContent = '✓';

    // Діалог гасне (після ефекту викликач його закриває; переривання повертає як було).
    play(source, [{ opacity: 1 }, { opacity: 0 }], T.dialogOut, 'ease-out', 'forwards');
    play(sign, [{ opacity: 0 }, { opacity: 1 }], T.signIn, 'ease-out');

    // Трубка, що заїкається: третя літера останнього слова («Д» у «ПОДАНО»), інакше остання.
    const last = words.at(-1) ?? '';
    const stutterAt = letters.length - last.length + Math.min(2, last.length - 1);
    const step = (T.letters[1] - T.letters[0] - LETTER_MS) / Math.max(1, letters.length - 1);
    letters.forEach((letter, i) => {
      const from = T.letters[0] + Math.round(i * step);
      const flick: Keyframe[] = [
        COLD,
        { ...LIT, offset: 0.3 },
        { ...COLD, offset: 0.5 },
        { ...LIT, offset: 0.75 },
        LIT,
      ];
      if (i !== stutterAt) {
        play(letter, flick, [from, from + LETTER_MS], 'steps(1, end)', 'both');
        return;
      }
      // Заїкання: загоряється й двічі гасне, перш ніж засвітитися рівно.
      play(
        letter,
        [
          COLD,
          { ...COLD, offset: 0.12 },
          { ...LIT, offset: 0.16 },
          { ...LIT, offset: 0.4 },
          { ...COLD, offset: 0.46 },
          { ...LIT, offset: 0.58 },
          { ...LIT, offset: 0.74 },
          { ...COLD, offset: 0.8 },
          { ...LIT, offset: 0.9 },
          LIT,
        ],
        [from, T.stutter[1]],
        'steps(1, end)',
        'both',
      );
    });

    play(
      tube,
      [
        { opacity: 0.25, boxShadow: 'none' },
        { opacity: 1, offset: 0.3, boxShadow: '0 0 6px #25dcff, 0 0 18px #25dcff' },
        { opacity: 0.25, offset: 0.5, boxShadow: 'none' },
        { opacity: 1, boxShadow: '0 0 6px #25dcff, 0 0 18px #25dcff' },
      ],
      T.tube,
      'steps(1, end)',
    );
    play(glow, [{ opacity: 0 }, { opacity: 1 }], T.glow, 'ease-in');
    play(reflection, [{ opacity: 0 }, { opacity: 0.4 }], T.reflection, 'ease-out');
    play(
      check,
      [
        { opacity: 0, transform: 'scale(0.4)' },
        { opacity: 1, offset: 0.7, transform: 'scale(1.15)' },
        { opacity: 1, transform: 'scale(1)' },
      ],
      T.check,
      'ease-out',
    );
    // Тихо гасне вся вивіска.
    play(sign, [{ opacity: 1 }, { opacity: 0 }], T.out, 'ease-in', 'forwards');
  });
};
