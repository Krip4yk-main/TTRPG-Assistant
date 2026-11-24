import { randomInt } from 'node:crypto';

export const PUBLIC_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export const PUBLIC_ID_LENGTH = 10;
export const PUBLIC_ID_ATTEMPTS = 5;

/** Випадковий незмінний публічний ідентифікатор користувача. */
export function generatePublicId(): string {
  let out = '';
  for (let i = 0; i < PUBLIC_ID_LENGTH; i++) {
    out += PUBLIC_ID_ALPHABET[randomInt(PUBLIC_ID_ALPHABET.length)];
  }
  return out;
}
