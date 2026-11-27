/**
 * Зовнішні посилання на картинки (обкладинка гри `coverUrl`): сервер перевіряє їх під час
 * збереження (лише коли значення змінилось і не `null`). Невдача — 422 `IMAGE_URL_INVALID`
 * з `details: { field, reason }` (текст — `errors.imageUrl.<reason>`):
 * - `unreachable` — не вдалося завантажити (немає хоста, помилка HTTP, забагато перенаправлень);
 * - `not_image` — відповідь не PNG/JPEG/WebP/GIF/AVIF;
 * - `too_large` — понад 5 МБ;
 * - `forbidden_address` — не https, нестандартний порт або приватна/локальна адреса;
 * - `timeout` — довше за 5 с.
 */
export const IMAGE_URL_INVALID_REASONS = [
  'unreachable',
  'not_image',
  'too_large',
  'forbidden_address',
  'timeout',
] as const;
export type ImageUrlInvalidReason = (typeof IMAGE_URL_INVALID_REASONS)[number];

export interface ImageUrlInvalidDetails {
  field: string;
  reason: ImageUrlInvalidReason;
}
