import { Injectable } from '@angular/core';
import type { NotificationDto } from '@nri/shared';

/** Сповіщення, на які вже відповіла анімація `acceptedNotice` (між перезавантаженнями). */
export const ACCEPTED_NOTICE_STORAGE_KEY = 'nri.moments.acceptedNotice';
/** Скільки останніх id пам'ятати (старіші давно прочитані чи видалені). */
const REMEMBER = 50;

/** Сповіщення «вас прийнято» в гру. */
export function isAcceptedNotice(n: NotificationDto): boolean {
  return n.type === 'application.approved';
}

/**
 * Момент `acceptedNotice`: один раз на сповіщення. Список сповіщень віддає рядки, які щойно
 * показав (`claim`), і отримує ті непрочитані «вас прийнято», для яких анімація ще не грала, —
 * вони одразу вважаються зіграними (у пам'яті й `localStorage`, щоб і після перезавантаження
 * не повторювалась). Недоступне сховище — пам'ятаємо до перезавантаження.
 */
@Injectable({ providedIn: 'root' })
export class AcceptedNoticeMoment {
  private readonly played: number[] = readPlayed();

  /** Непрочитані «вас прийнято» з `shown`, ще без анімації; позначає їх зіграними. */
  claim(shown: readonly NotificationDto[]): NotificationDto[] {
    const fresh = shown.filter(
      (n) => !n.readAt && isAcceptedNotice(n) && !this.played.includes(n.id),
    );
    if (fresh.length === 0) return [];
    this.played.push(...fresh.map((n) => n.id));
    this.played.splice(0, Math.max(0, this.played.length - REMEMBER));
    try {
      localStorage.setItem(ACCEPTED_NOTICE_STORAGE_KEY, JSON.stringify(this.played));
    } catch {
      // Сховище недоступне — пам'ятаємо до перезавантаження.
    }
    return fresh;
  }
}

function readPlayed(): number[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(ACCEPTED_NOTICE_STORAGE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((id): id is number => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}
