import { sql } from 'drizzle-orm';
import {
  bigint,
  datetime,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { TesterReportKind, TesterReportStatus } from '@nri/shared';
import { users } from './users.js';

// drizzle-kit не вміє вантажити ESM-пакет @nri/shared: значення — тут, збіг — через `satisfies`.
const KINDS = ['bug', 'idea', 'other'] as const satisfies TesterReportKind[];
const STATUSES = ['new', 'processed'] as const satisfies TesterReportStatus[];

const id = (name: string) => bigint(name, { mode: 'number', unsigned: true });

/**
 * Звіти тестувальників із dev-сервера (кнопка «Повідомити»). Автор — із сесії (гість — `NULL`);
 * контекст (сторінка, дизайн, вікно, user agent) — як надіслав браузер, адреса без секретних
 * параметрів. Видалення автора чи персоналу звіт не видаляє (SET NULL).
 */
export const testerReports = mysqlTable(
  'tester_reports',
  {
    id: id('id').autoincrement().primaryKey(),
    reporterId: id('reporter_id').references(() => users.id, { onDelete: 'set null' }),
    kind: mysqlEnum('kind', KINDS).notNull(),
    text: varchar('text', { length: 4000 }).notNull(),
    pageUrl: varchar('page_url', { length: 2048 }).notNull(),
    theme: varchar('theme', { length: 64 }).notNull(),
    viewportWidth: int('viewport_width', { unsigned: true }).notNull(),
    viewportHeight: int('viewport_height', { unsigned: true }).notNull(),
    userAgent: varchar('user_agent', { length: 512 }).notNull(),
    status: mysqlEnum('status', STATUSES).notNull().default('new'),
    processedBy: id('processed_by').references(() => users.id, { onDelete: 'set null' }),
    processedAt: datetime('processed_at', { fsp: 3 }),
    createdAt: datetime('created_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [index('tester_reports_status_id_idx').on(t.status, t.id)],
);
