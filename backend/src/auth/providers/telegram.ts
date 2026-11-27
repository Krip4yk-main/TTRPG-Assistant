import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../http/errors.js';
import type { VerifiedIdentity } from './provider.js';

const MAX_FUTURE_SKEW_SEC = 60;
const invalid = () => new AppError(401, 'TELEGRAM_AUTH_INVALID');

/**
 * Перевірка даних Telegram Login Widget (офіційний алгоритм):
 * secret = SHA256(botToken); hash = HMAC_SHA256(secret, відсортовані `key=value` через \n).
 */
export function verifyTelegramLogin(
  data: Record<string, string>,
  botToken: string,
  maxAgeSec: number,
  nowSec: number,
): VerifiedIdentity {
  const { hash, ...fields } = data;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) throw invalid();
  for (const v of Object.values(fields)) if (typeof v !== 'string') throw invalid();

  const check = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();

  const authDate = fields.auth_date;
  if (typeof authDate !== 'string' || !/^\d{1,12}$/.test(authDate)) throw invalid();
  const age = nowSec - Number(authDate);
  if (age > maxAgeSec || age < -MAX_FUTURE_SKEW_SEC) throw invalid();

  const id = fields.id;
  if (typeof id !== 'string' || !/^\d{1,20}$/.test(id)) throw invalid();

  return {
    provider: 'telegram',
    subject: id,
    displayName: fields.first_name || fields.username || undefined,
    avatarUrl: fields.photo_url || null,
  };
}
