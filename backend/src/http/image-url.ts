import type { ImageUrlInvalidReason } from '@nri/shared';
import { Semaphore } from '../scheduling/ical/slots.js';
import { AppError } from './errors.js';
import {
  createSafeGet,
  SafeFetchError,
  assertFetchableUrl,
  type SafeFetchOptions,
  type SafeFetchReason,
} from './safe-fetch.js';

/**
 * Перевірка зовнішнього посилання на картинку (обкладинка гри) під час збереження: лише https,
 * захист від SSRF (`createSafeGet`), дедлайн 5 с, до 3 перенаправлень (кожне перевіряється),
 * `Content-Type` — PNG/JPEG/WebP/GIF/AVIF, розмір до 5 МБ (за `Content-Length`, а без нього
 * потік читається й обривається після 5 МБ). Сама картинка не зберігається.
 */
export const IMAGE_CHECK_TIMEOUT_MS = 5_000;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MAX_REDIRECTS = 3;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];

const USER_AGENT = 'NRI-Assistant-Images/1.0';

/** Невдала перевірка — лише причина (без URL, хоста чи IP). */
export class ImageUrlError extends Error {
  constructor(public readonly reason: ImageUrlInvalidReason) {
    super(`image url check failed: ${reason}`);
    this.name = 'ImageUrlError';
  }
}

/** Перевіряє посилання; невдача — `ImageUrlError`. */
export type ImageUrlChecker = (url: string) => Promise<void>;

export interface ImageUrlCheckerOptions extends SafeFetchOptions {
  timeoutMs?: number;
}

const REASONS: Record<SafeFetchReason, ImageUrlInvalidReason> = {
  invalid_url: 'forbidden_address',
  blocked_address: 'forbidden_address',
  timeout: 'timeout',
  too_large: 'too_large',
  bad_content: 'not_image',
  dns_failed: 'unreachable',
  connect_failed: 'unreachable',
  redirect: 'unreachable',
  http_gone: 'unreachable',
  http_status: 'unreachable',
};

export function createImageUrlChecker(opts: ImageUrlCheckerOptions = {}): ImageUrlChecker {
  const get = createSafeGet({
    ...opts,
    timeoutMs: opts.timeoutMs ?? IMAGE_CHECK_TIMEOUT_MS,
    maxBytes: IMAGE_MAX_BYTES,
    maxRedirects: IMAGE_MAX_REDIRECTS,
    userAgent: USER_AGENT,
    accept: IMAGE_TYPES.join(', '),
    acceptHeaders: (headers) => {
      const type = String(headers['content-type'] ?? '')
        .split(';')[0]!
        .trim()
        .toLowerCase();
      return IMAGE_TYPES.includes(type);
    },
    body: 'measure',
  });
  return async (raw) => {
    try {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new SafeFetchError('invalid_url');
      }
      assertFetchableUrl(url, { allowedPorts: opts.allowedPorts });
      await get(url);
    } catch (err) {
      if (err instanceof SafeFetchError) throw new ImageUrlError(REASONS[err.reason]);
      throw err;
    }
  };
}

/** Одночасних перевірок картинок на процес (кожна — зовнішнє з'єднання до 5 с). */
const IMAGE_CHECK_SLOTS = 4;
const IMAGE_CHECK_SLOT_WAIT_MS = 10_000;
const imageCheckSlots = new Semaphore(IMAGE_CHECK_SLOTS);
const defaultChecker = createImageUrlChecker();

/**
 * Перевірка посилання під час збереження (викликати поза транзакцією БД). Невдача — 422
 * `IMAGE_URL_INVALID { field, reason }`; сервер зайнятий іншими перевірками — 429 `busy`.
 */
export async function assertImageUrl(
  deps: { imageUrlChecker?: ImageUrlChecker },
  field: string,
  url: string,
): Promise<void> {
  const release = await imageCheckSlots.acquire(IMAGE_CHECK_SLOT_WAIT_MS);
  if (!release) throw new AppError(429, 'RATE_LIMITED', { retryAfterSec: 30, reason: 'busy' });
  try {
    await (deps.imageUrlChecker ?? defaultChecker)(url);
  } catch (err) {
    if (err instanceof ImageUrlError) {
      throw new AppError(422, 'IMAGE_URL_INVALID', { field, reason: err.reason });
    }
    throw err;
  } finally {
    release();
  }
}
