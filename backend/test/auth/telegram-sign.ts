import { createHash, createHmac } from 'node:crypto';

export const TEST_BOT_TOKEN = '123456:FAKE-TEST-BOT-TOKEN';

/** Підписує поля віджета за офіційним алгоритмом Telegram Login Widget. */
export function sign(
  fields: Record<string, string>,
  token = TEST_BOT_TOKEN,
): Record<string, string> {
  const secret = createHash('sha256').update(token).digest();
  const check = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  return { ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') };
}
