import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Env } from '../../config/env.js';
import { AppError } from '../../http/errors.js';

/**
 * Шифрування iCal-посилань (секрет на кшталт пароля): AES-256-GCM, випадковий 12-байтовий IV
 * на кожне шифрування, AAD — id власника (рядок не можна «пересадити» іншому користувачу).
 * Формат: `v1.<iv>.<tag>.<ciphertext>` (base64url).
 */
const VERSION = 'v1';
const aad = (userId: number) => Buffer.from(`calendar-import:${userId}`, 'utf8');

export interface ImportKeys {
  current: Buffer;
  /** `CALENDAR_IMPORT_KEY_PREVIOUS` — лише для розшифрування під час ротації. */
  previous?: Buffer;
}

/** Ключі з env; поточного немає — імпорт вимкнено (fail closed, 503). */
export function importKeys(
  env: Pick<Env, 'CALENDAR_IMPORT_KEY' | 'CALENDAR_IMPORT_KEY_PREVIOUS'>,
): ImportKeys {
  if (!env.CALENDAR_IMPORT_KEY) throw new AppError(503, 'CALENDAR_IMPORT_DISABLED');
  return {
    current: Buffer.from(env.CALENDAR_IMPORT_KEY, 'base64'),
    previous: env.CALENDAR_IMPORT_KEY_PREVIOUS
      ? Buffer.from(env.CALENDAR_IMPORT_KEY_PREVIOUS, 'base64')
      : undefined,
  };
}

/** Поточний ключ (шифрування). */
export function importKey(env: Pick<Env, 'CALENDAR_IMPORT_KEY'>): Buffer {
  if (!env.CALENDAR_IMPORT_KEY) throw new AppError(503, 'CALENDAR_IMPORT_DISABLED');
  return Buffer.from(env.CALENDAR_IMPORT_KEY, 'base64');
}

/**
 * Розшифрування поточним ключем, інакше попереднім (`stale: true` — перешифрувати поточним).
 * Жоден не підходить — виняток.
 */
export function decryptWithKeys(
  keys: ImportKeys,
  userId: number,
  enc: string,
): { url: string; stale: boolean } {
  try {
    return { url: decryptUrl(keys.current, userId, enc), stale: false };
  } catch (err) {
    if (!keys.previous) throw err;
    return { url: decryptUrl(keys.previous, userId, enc), stale: true };
  }
}

export function encryptUrl(key: Buffer, userId: number, url: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(userId));
  const ct = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ct]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

/** Розшифрування; підроблений/чужий/пошкоджений рядок — виняток (без вмісту в повідомленні). */
export function decryptUrl(key: Buffer, userId: number, enc: string): string {
  const parts = enc.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION)
    throw new Error('calendar import: bad ciphertext');
  const [iv, tag, ct] = parts.slice(1).map((p) => Buffer.from(p, 'base64url'));
  // Повний 16-байтовий тег: укорочений полегшив би підробку.
  if (iv!.length !== 12 || tag!.length !== 16) throw new Error('calendar import: bad ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, iv!, { authTagLength: 16 });
  decipher.setAAD(aad(userId));
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(ct!), decipher.final()]).toString('utf8');
}
