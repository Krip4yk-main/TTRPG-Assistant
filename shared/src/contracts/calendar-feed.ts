/**
 * Вихідна ICS-підписка на «мої сесії» (Plan 13 Task 10): секретне посилання
 * `/api/cal/<token>.ics`, яке календар (Google / Apple / Outlook) періодично завантажує.
 * Токен показується лише у відповіді на створення/перевипуск; сервер зберігає тільки його
 * SHA-256-хеш.
 */

/** Вікно подій фіду: від «зараз − 30 днів» до «зараз + 180 днів». */
export const CALENDAR_FEED_PAST_DAYS = 30;
export const CALENDAR_FEED_FUTURE_DAYS = 180;
/** Найбільше подій у фіді. */
export const CALENDAR_FEED_MAX_EVENTS = 500;

/** `GET /api/me/calendar-feed` — без токена. */
export interface CalendarFeedStatusDto {
  enabled: boolean;
  /** Коли видано чинне посилання (ISO), `null` — підписку вимкнено. */
  createdAt: string | null;
}

/** `POST /api/me/calendar-feed` — створення або перевипуск: єдиний раз, коли видно посилання. */
export interface CalendarFeedCreatedDto {
  url: string;
  createdAt: string;
}
