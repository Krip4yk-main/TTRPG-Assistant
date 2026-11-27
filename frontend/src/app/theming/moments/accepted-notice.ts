import { Injectable } from '@angular/core';
import type { NotificationDto } from '@nri/shared';

/**
 * Сповіщення, на які вже відповіла анімація `acceptedNotice` (між перезавантаженнями). Ключ —
 * на браузер, не на користувача: id сповіщень глобальні, тож id різних акаунтів не плутаються;
 * в іншому браузері чи пристрої анімація зіграє ще раз.
 */
export const ACCEPTED_NOTICE_STORAGE_KEY = 'nri.moments.acceptedNotice';
/** Скільки останніх id пам'ятати (старіші давно прочитані чи видалені). */
const REMEMBER = 50;

/** Сповіщення «вас прийнято» в гру. */
export function isAcceptedNotice(n: NotificationDto): boolean {
  return n.type === 'application.approved';
}

/**
 * Момент `acceptedNotice`: один раз на сповіщення (у цьому браузері). Список сповіщень питає
 * кандидатів (`candidates`) — непрочитані «вас прийнято», для яких анімація ще не грала, — і
 * позначає зіграним (`markPlayed`) лише те, на якому справді запустив ефект (рядок видно в
 * панелі, чинний дизайн анімує момент). Зіграні пам'ятаються й у `localStorage`, щоб і після
 * перезавантаження не повторювались. Недоступне сховище — пам'ятаємо до перезавантаження.
 */
@Injectable({ providedIn: 'root' })
export class AcceptedNoticeMoment {
  private readonly played: number[] = readPlayed();

  /** Непрочитані «вас прийнято» з `shown`, ще без анімації (у тому ж порядку); без побічних дій. */
  candidates(shown: readonly NotificationDto[]): NotificationDto[] {
    return shown.filter((n) => !n.readAt && isAcceptedNotice(n) && !this.played.includes(n.id));
  }

  /** Анімація для сповіщення `id` зіграла — більше не повторювати. */
  markPlayed(id: number): void {
    if (this.played.includes(id)) return;
    this.played.push(id);
    this.played.splice(0, Math.max(0, this.played.length - REMEMBER));
    try {
      localStorage.setItem(ACCEPTED_NOTICE_STORAGE_KEY, JSON.stringify(this.played));
    } catch {
      // Сховище недоступне — пам'ятаємо до перезавантаження.
    }
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
