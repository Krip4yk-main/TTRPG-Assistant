import { runEffectStage } from '../../../effect-stage';
import type { ThemeEffect } from '../../../theme.registry';

/**
 * «Нічне місто»: заявку подано — над діалогом проступає силова шина з затискачами (як шина,
 * на якій висять картки). Діод «свого» затискача горить рожевим, з нього зривається рожевий
 * імпульс і біжить шиною; сусідні діоди блимають бірюзою — «квитують»; свій діод стає зеленим,
 * рамка діалогу світиться зеленим, а внизу — табличка «● Заявку передано» (uk.json
 * `theme.effects.nightCity.status`). Далі шина згасає, діалог закриває викликач. Разом ≈ 1.4 с.
 * Вигляд — класи `nc-send-*` (`application-sent.less`).
 */

/** Таймінги фаз, мс від початку. */
const T = {
  busIn: [0, 220],
  homeArm: [120, 300],
  pulse: [260, 680],
  midAck: [420, 640],
  farAck: [640, 900],
  green: [880, 1020],
  out: [1180, 1400],
} as const;
/** Затискачі на шині: частка ширини діалогу. */
const NODES = { home: 0.16, mid: 0.5, far: 0.84 } as const;
/** Шина над діалогом, якщо над ним є місце, інакше — по його верхньому краю. */
const BUS_ABOVE = -18;
const BUS_INSIDE = 10;

// Кольори діодів — токени дизайну (`night-city.less`): рожевий і ціан неону, лайм «готово».
const DIODE_OFF: Keyframe = { background: '#3a3e4c', boxShadow: '0 0 0 rgba(0, 0, 0, 0)' };
const DIODE_PINK: Keyframe = {
  background: '#ffd3e5',
  boxShadow: '0 0 5px #ff3d8b, 0 0 12px #ff3d8b',
};
const DIODE_CYAN: Keyframe = {
  background: '#d3f8ff',
  boxShadow: '0 0 5px #3fe3ff, 0 0 12px #3fe3ff',
};
const DIODE_LIME: Keyframe = {
  background: '#ecffd8',
  boxShadow: '0 0 6px #9dff4d, 0 0 14px #9dff4d',
};

export const pulseAlongBus: ThemeEffect = async (source, signal, text) => {
  await runEffectStage(source, signal, 'nc-send', ({ add, play, rect, doc }) => {
    const w = rect.width;

    const bus = add('nc-send-bus');
    bus.style.top = `${rect.top + BUS_ABOVE >= 4 ? BUS_ABOVE : BUS_INSIDE}px`;
    add('nc-send-rail', bus);
    const diode = (at: number) => {
      const clamp = add('nc-send-clamp', bus);
      clamp.style.left = `${Math.round(w * at)}px`;
      return add('nc-send-diode', clamp);
    };
    const home = diode(NODES.home);
    const mid = diode(NODES.mid);
    const far = diode(NODES.far);
    const pulse = add('nc-send-pulse', bus);
    const frame = add('nc-send-frame');
    frame.style.borderRadius = doc.defaultView?.getComputedStyle(source).borderRadius ?? '';
    const status = add('nc-send-status');
    status.textContent = text('theme.effects.nightCity.status');

    play(bus, [{ opacity: 0 }, { opacity: 1 }], T.busIn, 'ease-out');
    play(home, [DIODE_OFF, DIODE_PINK], T.homeArm, 'ease-out');

    // Імпульс — від свого затискача до дальнього (кометою, хвіст позаду).
    const fromX = w * NODES.home;
    const toX = w * NODES.far;
    play(
      pulse,
      [
        { opacity: 0, transform: `translateX(${fromX}px) scaleX(0.3)` },
        { opacity: 1, offset: 0.15, transform: `translateX(${fromX + 12}px) scaleX(1)` },
        { opacity: 1, offset: 0.85, transform: `translateX(${toX - 12}px) scaleX(1)` },
        { opacity: 0, transform: `translateX(${toX}px) scaleX(0.3)` },
      ],
      T.pulse,
      'cubic-bezier(0.5, 0, 0.6, 1)',
    );
    // Сусіди квитують: короткі спалахи бірюзою.
    const ack = (el: HTMLElement, span: readonly [number, number]) =>
      play(
        el,
        [
          DIODE_OFF,
          { ...DIODE_CYAN, offset: 0.25 },
          { ...DIODE_OFF, offset: 0.5 },
          { ...DIODE_CYAN, offset: 0.75 },
          DIODE_OFF,
        ],
        span,
        'steps(1, end)',
      );
    ack(mid, T.midAck);
    ack(far, T.farAck);
    // Свій вузол — зелений; рамка діалогу й табличка статусу.
    play(home, [DIODE_PINK, DIODE_LIME], T.green, 'ease-out', 'forwards');
    play(frame, [{ opacity: 0 }, { opacity: 1 }], T.green, 'ease-out');
    play(
      status,
      [
        { opacity: 0, transform: 'translateY(6px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      T.green,
      'ease-out',
    );
    // Усе згасає разом.
    for (const el of [bus, frame, status]) {
      play(el, [{ opacity: 1 }, { opacity: 0 }], T.out, 'ease-in', 'forwards');
    }
  });
};
