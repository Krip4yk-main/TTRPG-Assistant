import { openEffectStage } from '../../../effect-stage';
import type { ThemeEffect } from '../../../theme.registry';

/**
 * «Латунь і пара»: заявку подано — телеграф «приймає». З латунної щілини вгорі праворуч на
 * діалозі ривками, по літері, виповзає паперова стрічка «ЗАЯВКУ ПОДАНО STOP» (uk.json
 * `theme.effects.brassSteam.tape`); на «STOP» бланк гупає гумовим штампом «ВІДПРАВЛЕНО»
 * (`…stamp`) червоним чорнилом, стрілка манометра внизу праворуч стрибає в червоне; далі
 * стрічка відривається й падає, стрілка осідає, з манометра — пшик пари. Діалог закриває
 * викликач. Разом ≈ 1.6 с. Вигляд — класи `bs-send-*` (`application-sent.less`).
 */

/** Таймінги фаз, мс від початку. */
const T = {
  brassIn: [0, 200],
  tape: [220, 900],
  stamp: [900, 1060],
  gaugeJump: [900, 1080],
  gaugeSettle: [1080, 1500],
  tear: [1240, 1560],
  steam: [1220, 1600],
  out: [1420, 1600],
} as const;
/** Кути стрілки манометра (0 — вертикально вгору). */
const NEEDLE = { rest: -60, peak: 78, settle: 38 } as const;
const STEAM_PUFFS = 4;

export const printTelegraphTape: ThemeEffect = async (source, signal, text) => {
  const stage = openEffectStage(source, signal, 'bs-send');
  if (!stage) return;
  const { add, play } = stage;

  const brass = add('bs-send-brass');
  add('bs-send-slot', brass);
  const well = add('bs-send-well', brass);
  const tape = add('bs-send-tape', well);
  const message = text('theme.effects.brassSteam.tape');
  tape.textContent = message;
  const stamp = add('bs-send-stamp');
  stamp.textContent = text('theme.effects.brassSteam.stamp');
  const gauge = add('bs-send-gauge', brass);
  const needle = add('bs-send-needle', gauge);
  const puffs = Array.from({ length: STEAM_PUFFS }, () => add('bs-send-steam', gauge));

  play(brass, [{ opacity: 0 }, { opacity: 1 }], T.brassIn, 'ease-out');

  // Друк: стрічка висувається зі щілини ривками — крок на літеру.
  const chars = Math.max(1, [...message].length);
  play(
    tape,
    [{ transform: 'translateY(-100%)' }, { transform: 'translateY(0)' }],
    T.tape,
    `steps(${chars}, end)`,
  );
  // Стрічка відривається й падає, крутнувшись.
  play(
    tape,
    [
      { opacity: 1, transform: 'translateY(0) rotate(0deg)' },
      { opacity: 1, offset: 0.2, transform: 'translateY(4px) rotate(-3deg)' },
      { opacity: 0, transform: 'translate(-14px, 70px) rotate(14deg)' },
    ],
    T.tear,
    'ease-in',
    'forwards',
  );

  // Штамп: падає й вдавлюється.
  play(
    stamp,
    [
      { opacity: 0, transform: 'translate(-50%, -50%) rotate(-8deg) scale(1.9)' },
      { opacity: 1, offset: 0.65, transform: 'translate(-50%, -50%) rotate(-8deg) scale(0.94)' },
      { opacity: 1, transform: 'translate(-50%, -50%) rotate(-8deg) scale(1)' },
    ],
    T.stamp,
    'ease-in',
  );

  // Манометр: стрибок у червоне, тремтіння й осідання.
  const turn = (deg: number): Keyframe => ({ transform: `rotate(${deg}deg)` });
  play(
    needle,
    [turn(NEEDLE.rest), turn(NEEDLE.peak)],
    T.gaugeJump,
    'cubic-bezier(0.2, 1.4, 0.5, 1)',
  );
  play(
    needle,
    [
      turn(NEEDLE.peak),
      { ...turn(NEEDLE.peak - 14), offset: 0.3 },
      { ...turn(NEEDLE.settle + 6), offset: 0.6 },
      turn(NEEDLE.settle),
    ],
    T.gaugeSettle,
    'ease-out',
    'forwards',
  );

  // Пшик пари: клуби ростуть і розтають угору.
  puffs.forEach((puff, i) => {
    const dx = (i - (STEAM_PUFFS - 1) / 2) * 9;
    const from = T.steam[0] + i * 40;
    play(
      puff,
      [
        { opacity: 0, transform: 'translate(-50%, 0) scale(0.4)' },
        {
          opacity: 0.85,
          offset: 0.3,
          transform: `translate(calc(-50% + ${dx / 2}px), -14px) scale(1)`,
        },
        { opacity: 0, transform: `translate(calc(-50% + ${dx}px), -40px) scale(2.2)` },
      ],
      [from, T.steam[1]],
      'ease-out',
    );
  });

  // Латунь і штамп згасають наприкінці.
  for (const el of [brass, stamp]) {
    play(el, [{ opacity: 1 }, { opacity: 0 }], T.out, 'ease-in', 'forwards');
  }

  await stage.finish();
};
