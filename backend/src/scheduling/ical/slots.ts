import { Semaphore } from '../../lib/semaphore.js';

/** Одночасних завантажень + розборів iCal на процес. */
export const IMPORT_SLOTS = 4;
/** Скільки `PUT`/ручне «Оновити» чекає на вільний слот, перш ніж відповісти 429. */
export const IMPORT_SLOT_WAIT_MS = 10_000;
/**
 * Імпорт iCal (`PUT`, ручне «Оновити», джоб) бере слот на завантаження + розбір: не більше
 * `IMPORT_SLOTS` одночасно на процес, тож паралельні запити не створять необмеженої кількості
 * з'єднань і потоків розбору (кожен — до 192 МБ купи).
 */
export const importSlots = new Semaphore(IMPORT_SLOTS);
