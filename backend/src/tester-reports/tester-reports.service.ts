import { and, desc, eq, lt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import {
  stripReportUrlSecrets,
  testerReportInputSchema,
  testerReportsQuerySchema,
  type AdminPageDto,
  type TesterReportCreatedDto,
  type TesterReportDto,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import { testerReports, users } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import {
  createNotification,
  emitNotificationsNew,
  type NotificationRow,
} from '../notifications/notifications.service.js';

/**
 * `POST /api/tester-reports` (лише dev): зберігає звіт і сповіщає на сайті кожного активного
 * незабаненого власника платформи (`tester.report`). Автор — із сесії (`reporterId`, гість —
 * `null`); адреса сторінки — без секретних параметрів (і на випадок старого клієнта).
 */
export async function submitTesterReport(
  deps: Pick<AppDeps, 'db' | 'env' | 'realtime'>,
  reporterId: number | null,
  body: unknown,
): Promise<TesterReportCreatedDto> {
  const { kind, text, context } = testerReportInputSchema.parse(body);
  const { id, created } = await deps.db.transaction(async (tx) => {
    const [res] = await tx
      .insert(testerReports)
      .values({
        reporterId,
        kind,
        text,
        pageUrl: stripReportUrlSecrets(context.url),
        theme: context.theme,
        viewportWidth: context.viewportWidth,
        viewportHeight: context.viewportHeight,
        userAgent: context.userAgent,
      })
      .$returningId();
    const owners = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'owner'), eq(users.status, 'active'), eq(users.isBanned, false)));
    const rows: NotificationRow[] = [];
    for (const o of owners) {
      rows.push(
        await createNotification(deps, tx, {
          userId: o.id,
          type: 'tester.report',
          category: 'moderation',
          params: {},
          entityType: null,
          entityId: null,
        }),
      );
    }
    return { id: res!.id, created: rows };
  });
  emitNotificationsNew(deps, created);
  return { id };
}

const reporterU = alias(users, 'tester_report_reporter');
const processorU = alias(users, 'tester_report_processor');

function baseQuery(db: AppDeps['db']) {
  return db
    .select({
      r: testerReports,
      reporter: {
        publicId: reporterU.publicId,
        nickname: reporterU.nickname,
        role: reporterU.role,
      },
      processor: {
        publicId: processorU.publicId,
        nickname: processorU.nickname,
        role: processorU.role,
      },
    })
    .from(testerReports)
    .leftJoin(reporterU, eq(reporterU.id, testerReports.reporterId))
    .leftJoin(processorU, eq(processorU.id, testerReports.processedBy));
}

type Row = Awaited<ReturnType<ReturnType<typeof baseQuery>['execute']>>[number];

function toDto(row: Row): TesterReportDto {
  const r = row.r;
  return {
    id: r.id,
    kind: r.kind,
    text: r.text,
    status: r.status,
    context: {
      url: r.pageUrl,
      theme: r.theme,
      viewportWidth: r.viewportWidth,
      viewportHeight: r.viewportHeight,
      userAgent: r.userAgent,
    },
    reporter: r.reporterId !== null && row.reporter ? row.reporter : null,
    processedBy: r.processedBy !== null && row.processor ? row.processor : null,
    processedAt: r.processedAt ? r.processedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** `GET /api/admin/tester-reports?status=&cursor=&limit=` — новіші першими. */
export async function listTesterReports(
  deps: Pick<AppDeps, 'db'>,
  query: unknown,
): Promise<AdminPageDto<TesterReportDto>> {
  const { status, cursor, limit } = testerReportsQuerySchema.parse(query);
  const rows = await baseQuery(deps.db)
    .where(
      and(
        status ? eq(testerReports.status, status) : undefined,
        cursor !== undefined ? lt(testerReports.id, cursor) : undefined,
      ),
    )
    .orderBy(desc(testerReports.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    items: page.map(toDto),
    nextCursor: rows.length > limit ? page[page.length - 1]!.r.id : null,
  };
}

/**
 * `POST /api/admin/tester-reports/:id/processed` — позначка «Опрацьовано». Уже опрацьований —
 * без змін (хто й коли — перший, хто позначив); немає — 404.
 */
export async function markTesterReportProcessed(
  deps: Pick<AppDeps, 'db'>,
  staffId: number,
  id: number,
): Promise<TesterReportDto> {
  await deps.db
    .update(testerReports)
    .set({ status: 'processed', processedBy: staffId, processedAt: new Date() })
    .where(and(eq(testerReports.id, id), eq(testerReports.status, 'new')));
  const [row] = await baseQuery(deps.db).where(eq(testerReports.id, id));
  if (!row) throw new AppError(404, 'NOT_FOUND');
  return toDto(row);
}
