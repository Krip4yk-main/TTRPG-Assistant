import { runEffectStage } from '../../../effect-stage';
import type { ThemeEffect } from '../../../theme.registry';

/**
 * «Сонячний сад»: заявку подано — «Паросток». Біля кнопки заявки (нижній правий кут діалогу)
 * з'являється грядка під сонцем: пакетик «Насіння гри» (uk.json `theme.effects.solarGarden.packet`)
 * нахиляється й роняє насінину, та пірнає в ґрунт (горбик ледь здіймається), проклюнується
 * паросток, розгортає дві сім'ядолі, сонце «торкається» променем; паросток підростає, і на
 * шпагаті гойдається дерев'яна бирка «Заявку подано» (`…tag`). Далі грядка тихо зникає, діалог
 * закриває викликач. Сам діалог ефект не чіпає. Разом 1.6 с. Вигляд — класи `sg-send-*`
 * (`application-sent.less`).
 */

/** Таймінги фаз, мс від початку. */
const T = {
  bedIn: [0, 160],
  packetTilt: [60, 300],
  packetOut: [420, 700],
  seedFall: [220, 520],
  seedDive: [520, 640],
  mound: [520, 680],
  sprout: [640, 880],
  leaves: [720, 960],
  rays: [760, 1000],
  grow: [880, 1240],
  tagSwing: [1120, 1460],
  out: [1460, 1600],
} as const;
/** Розміри грядки й рослини, px. */
const BED = { w: 232, h: 204, inset: 12 } as const;
const SOIL_H = 50;
const STEM_MAX = 84;
/** Паросток — на цій частці ширини грядки. */
const SPROUT_AT = 0.4;
/** Висота проклюнутого паростка — частка повної. */
const SPROUT_SHOOT = 0.42;

export const growSprout: ThemeEffect = async (source, signal, text) => {
  await runEffectStage(source, signal, 'sg-send', ({ add, play, rect }) => {
    const w = Math.min(BED.w, rect.width - 2 * BED.inset);
    const h = Math.min(BED.h, rect.height - 2 * BED.inset);
    const stemH = Math.max(36, Math.min(STEM_MAX, h - SOIL_H - 60));
    const sproutX = Math.round(w * SPROUT_AT);

    const bed = add('sg-send-bed');
    Object.assign(bed.style, { width: `${w}px`, height: `${h}px` });
    const rays = add('sg-send-rays', bed);
    add('sg-send-soil', bed);

    const packet = add('sg-send-packet', bed);
    add('sg-send-packet-sun', packet);
    add('sg-send-packet-label', packet).textContent = text('theme.effects.solarGarden.packet');

    const mound = add('sg-send-mound', bed);
    mound.style.left = `${sproutX}px`;
    const seed = add('sg-send-seed', bed);
    seed.style.left = `${sproutX}px`;

    // Паросток: стебло росте від землі (scaleY), «крона» з сім'ядолями й шпагатом з биркою
    // їде вгору тими самими кадрами — лишається на верхівці, не розтягуючись.
    const stem = add('sg-send-stem', bed);
    Object.assign(stem.style, { left: `${sproutX}px`, height: `${stemH}px` });
    const crown = add('sg-send-crown', bed);
    crown.style.left = `${sproutX}px`;
    const leafL = add('sg-send-leaf sg-send-leaf-l', crown);
    const leafR = add('sg-send-leaf sg-send-leaf-r', crown);
    const tag = add('sg-send-tag', crown);
    tag.style.maxWidth = `${Math.max(72, w - sproutX - 14)}px`;
    add('sg-send-twine', tag);
    add('sg-send-tag-text', tag, 'span').textContent = text('theme.effects.solarGarden.tag');

    play(bed, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1 }], T.bedIn, 'ease-out');

    // Пакетик нахиляється, роняє насінину й іде.
    play(
      packet,
      [{ transform: 'rotate(-6deg)' }, { transform: 'rotate(-34deg)' }],
      T.packetTilt,
      'cubic-bezier(.3,1.4,.6,1)',
    );
    play(
      packet,
      [
        { opacity: 1, transform: 'rotate(-34deg)' },
        { opacity: 0, transform: 'translate(10px, -14px) rotate(-12deg)' },
      ],
      T.packetOut,
      'ease-in',
      'forwards',
    );

    // Насінина: з горлечка пакетика (≈ на 62% ширини, 40 px від верху) — у ґрунт.
    const fromX = Math.round(w * 0.62) - sproutX;
    const fromY = -(h - SOIL_H - 40);
    play(
      seed,
      [
        { opacity: 0, transform: `translate(${fromX}px, ${fromY}px) rotate(-30deg)` },
        {
          opacity: 1,
          offset: 0.1,
          transform: `translate(${fromX}px, ${fromY + 6}px) rotate(-20deg)`,
        },
        { opacity: 1, transform: 'translate(0, 0) rotate(20deg)' },
      ],
      T.seedFall,
      'cubic-bezier(.5,0,.9,.6)',
    );
    play(
      seed,
      [
        { opacity: 1, transform: 'translate(0, 0) scale(1)' },
        { opacity: 0, transform: 'translate(0, 6px) scale(0.6)' },
      ],
      T.seedDive,
      'ease-in',
      'forwards',
    );
    play(
      mound,
      [
        { transform: 'scaleY(0)' },
        { offset: 0.6, transform: 'scaleY(1.25)' },
        { transform: 'scaleY(1)' },
      ],
      T.mound,
      'ease-out',
    );

    // Проклюнувся (частка висоти), потім підріс до повної — стебло й крона синхронно (друга
    // фаза — лише `forwards`, щоб до свого старту не перекривала першу).
    const shoot = SPROUT_SHOOT;
    play(
      stem,
      [{ transform: 'scaleY(0)' }, { transform: `scaleY(${shoot})` }],
      T.sprout,
      'ease-out',
    );
    play(
      stem,
      [{ transform: `scaleY(${shoot})` }, { transform: 'scaleY(1)' }],
      T.grow,
      'ease-out',
      'forwards',
    );
    const lift = (k: number) => `translateY(${-Math.round(stemH * k)}px)`;
    play(
      crown,
      [
        { opacity: 0, transform: lift(0) },
        { opacity: 1, offset: 0.3, transform: lift(shoot * 0.3) },
        { opacity: 1, transform: lift(shoot) },
      ],
      T.sprout,
      'ease-out',
    );
    play(
      crown,
      [{ transform: lift(shoot) }, { transform: lift(1) }],
      T.grow,
      'ease-out',
      'forwards',
    );
    for (const [leaf, side] of [
      [leafL, -1],
      [leafR, 1],
    ] as const) {
      play(
        leaf,
        [
          // Згорнута — догори, розгортається з перехлестом і трохи піднімає кінчик.
          { transform: `rotate(${-side * 70}deg) scale(0.2)` },
          { offset: 0.7, transform: `rotate(${side * 4}deg) scale(1.08)` },
          { transform: `rotate(${-side * 20}deg) scale(1)` },
        ],
        T.leaves,
        'ease-out',
      );
    }
    play(rays, [{ opacity: 0 }, { opacity: 1 }], T.rays, 'ease-out');

    // Бирка: з'являється на шпагаті й гойдається, затихаючи.
    play(
      tag,
      [
        { opacity: 0, transform: 'rotate(-24deg)' },
        { opacity: 1, offset: 0.2, transform: 'rotate(-24deg)' },
        { opacity: 1, offset: 0.5, transform: 'rotate(10deg)' },
        { opacity: 1, offset: 0.75, transform: 'rotate(-9deg)' },
        { opacity: 1, transform: 'rotate(-5deg)' },
      ],
      T.tagSwing,
      'ease-in-out',
    );

    play(bed, [{ opacity: 1 }, { opacity: 0 }], T.out, 'ease-in', 'forwards');
  });
};
