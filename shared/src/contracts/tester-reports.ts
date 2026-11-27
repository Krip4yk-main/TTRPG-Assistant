import { z } from 'zod';
import { ADMIN_PAGE_DEFAULT, ADMIN_PAGE_MAX, type ModerationUserRefDto } from './moderation.js';

/**
 * Звіти тестувальників (лише на dev-сервері, `DEPLOY_ENV=dev`): кнопка «Повідомити» внизу
 * справа на кожній сторінці. Поза dev ендпоінти відповідають 404.
 */
export const TESTER_REPORT_KINDS = ['bug', 'idea', 'other'] as const;
export type TesterReportKind = (typeof TESTER_REPORT_KINDS)[number];

export const TESTER_REPORT_STATUSES = ['new', 'processed'] as const;
export type TesterReportStatus = (typeof TESTER_REPORT_STATUSES)[number];

export const TESTER_REPORT_TEXT_MAX = 4000;
/** Ліміт `POST /api/tester-reports`: звітів на годину з однієї IP. */
export const TESTER_REPORTS_PER_HOUR = 10;

export const TESTER_REPORT_URL_MAX = 2048;
export const TESTER_REPORT_THEME_MAX = 64;
export const TESTER_REPORT_UA_MAX = 512;
const VIEWPORT_MAX = 100_000;

/** Параметри запиту, що можуть бути секретами (токени входу, коди OAuth) — не потрапляють у звіт. */
export const TESTER_REPORT_SECRET_PARAMS = ['token', 'code'] as const;

/**
 * Адреса сторінки для звіту: шлях і query без секретних параметрів (`token`, `code`) і без
 * фрагмента (`#…` теж буває носієм токена). Без `URL` — shared не залежить від DOM/Node-типів.
 */
export function stripReportUrlSecrets(href: string): string {
  const noHash = href.split('#', 1)[0]!;
  const q = noHash.indexOf('?');
  if (q < 0) return noHash;
  const secret = new Set<string>(TESTER_REPORT_SECRET_PARAMS);
  const kept = noHash
    .slice(q + 1)
    .split('&')
    .filter((pair) => {
      if (!pair) return false;
      const raw = pair.split('=', 1)[0]!.replace(/\+/g, ' ');
      let name = raw;
      try {
        name = decodeURIComponent(raw);
      } catch {
        // Зіпсоване кодування — порівнюємо як є.
      }
      return !secret.has(name.toLowerCase());
    });
  const base = noHash.slice(0, q);
  return kept.length ? `${base}?${kept.join('&')}` : base;
}

/** Контекст, що додається до звіту автоматично (користувач бачить його у формі). */
export const testerReportContextSchema = z
  .object({
    url: z.string().max(TESTER_REPORT_URL_MAX),
    theme: z.string().max(TESTER_REPORT_THEME_MAX),
    viewportWidth: z.number().int().min(0).max(VIEWPORT_MAX),
    viewportHeight: z.number().int().min(0).max(VIEWPORT_MAX),
    userAgent: z.string().max(TESTER_REPORT_UA_MAX),
  })
  .strict();
export type TesterReportContext = z.infer<typeof testerReportContextSchema>;

/**
 * Тіло `POST /api/tester-reports`. Автор — із сесії (гість — без автора), клієнтові не віримо.
 */
export const testerReportInputSchema = z
  .object({
    kind: z.enum(TESTER_REPORT_KINDS),
    text: z.string().trim().min(1).max(TESTER_REPORT_TEXT_MAX),
    context: testerReportContextSchema,
  })
  .strict();
export type TesterReportInput = z.input<typeof testerReportInputSchema>;

/** Відповідь `POST /api/tester-reports` (201). */
export interface TesterReportCreatedDto {
  id: number;
}

/** Query `GET /api/admin/tester-reports`: без `status` — усі; новіші першими. */
export const testerReportsQuerySchema = z.object({
  status: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(TESTER_REPORT_STATUSES).optional(),
  ),
  // Порожній `cursor=` — як відсутній.
  cursor: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  limit: z.coerce.number().int().min(1).max(ADMIN_PAGE_MAX).default(ADMIN_PAGE_DEFAULT),
});
export type TesterReportsQuery = z.input<typeof testerReportsQuerySchema>;

/** Звіт для адмінки (`GET /api/admin/tester-reports`). `reporter = null` — гість. */
export interface TesterReportDto {
  id: number;
  kind: TesterReportKind;
  text: string;
  status: TesterReportStatus;
  context: TesterReportContext;
  reporter: ModerationUserRefDto | null;
  processedBy: ModerationUserRefDto | null;
  processedAt: string | null;
  createdAt: string;
}
