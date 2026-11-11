import type { AdminAuditEntryDto, AuditSource, Paginated } from '@asra/types';
import type { AdminAuditLogQuery } from '@asra/validation';
import { prisma } from '../../database/prisma.js';
import type { DbClient } from '../../database/types.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { pageArgs, paginated } from '../../utils/pagination.js';
import { zonedDayRange } from './range.js';

/**
 * Administrative audit trail (PHASE 12, docs/ADMIN-DASHBOARD.md §7). Written in the SAME
 * transaction as the change it records, so a committed change always has its entry and a
 * rolled-back one never does. Append-only: no code path updates or deletes these rows, and no
 * endpoint exposes a write. `data` holds ids, previous/new values and short reasons only — never
 * passwords, tokens, keys or payment instrument data.
 *
 * Payment and assessment actions keep their own, older trails (payment_audit_logs,
 * assessment_audit_logs); the viewer below reads all three.
 */
export type AdminAuditAction =
  | 'user.status_changed'
  | 'user.role_granted'
  | 'user.role_revoked'
  | 'course.published'
  | 'course.unpublished'
  | 'course.archived'
  | 'course.restored'
  | 'course.instructors_changed'
  | 'live_class.scheduled'
  | 'live_class.rescheduled'
  | 'live_class.cancelled'
  | 'enrollment.created_by_admin'
  | 'enrollment.cancelled_by_admin'
  | 'certificate.issued_by_admin'
  | 'certificate.reissued_by_admin'
  | 'certificate.revoked_by_admin'
  | 'certificate.template_updated'
  | 'certificate.signature_created'
  | 'certificate.signature_updated'
  | 'certificate.settings_updated'
  | 'job.created'
  | 'job.updated'
  | 'job.published'
  | 'job.unpublished'
  | 'job.archived'
  | 'job.deleted'
  | 'application.status_changed'
  | 'interview.scheduled'
  | 'interview.rescheduled'
  | 'interview.cancelled'
  | 'recruitment.email_sent'
  | 'academy_quiz.created'
  | 'academy_quiz.updated'
  | 'academy_quiz.deleted'
  | 'academy_quiz.published'
  | 'academy_quiz.unpublished'
  | 'academy_quiz.closed'
  | 'academy_quiz.reopened'
  | 'academy_quiz.results_published'
  | 'academy_quiz.questions_copied'
  | 'announcement.created'
  | 'announcement.updated'
  | 'announcement.priority_updated'
  | 'announcement.published'
  | 'announcement.scheduled'
  | 'announcement.paused'
  | 'announcement.resumed'
  | 'announcement.archived'
  | 'announcement.restored'
  | 'announcement.deleted';

export type AdminAuditEntity =
  | 'user'
  | 'course'
  | 'live_class'
  | 'enrollment'
  | 'certificate'
  | 'certificate_template'
  | 'certificate_signature'
  | 'certificate_settings'
  | 'job'
  | 'job_application'
  | 'academy_quiz'
  | 'announcement';

export async function adminAudit(
  db: DbClient,
  entry: {
    action: AdminAuditAction;
    actorId: string | null;
    entityType: AdminAuditEntity;
    entityId: string;
    data?: Prisma.InputJsonObject;
  },
): Promise<void> {
  await db.adminAuditLog.create({
    data: {
      action: entry.action,
      actorId: entry.actorId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      ...(entry.data ? { data: entry.data } : {}),
    },
  });
}

interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  data: Prisma.JsonValue;
  createdAt: Date;
  actor: { id: string; fullName: string } | null;
}

const auditSelect = {
  id: true,
  action: true,
  entityType: true,
  entityId: true,
  data: true,
  createdAt: true,
  actor: { select: { id: true, fullName: true } },
} as const;

function toEntry(source: AuditSource, row: AuditRow): AdminAuditEntryDto {
  return {
    id: row.id,
    source,
    action: row.action,
    actor: row.actor ? { userId: row.actor.id, fullName: row.actor.fullName } : null,
    entityType: row.entityType,
    entityId: row.entityId,
    data:
      row.data && typeof row.data === 'object' && !Array.isArray(row.data)
        ? (row.data as Record<string, unknown>)
        : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The three tables share one shape; this keeps a single filter definition for all of them. */
interface AuditWhere {
  action?: string | { startsWith: string };
  actorId?: string;
  entityId?: string;
  createdAt?: { gte?: Date; lt?: Date };
}

export const auditLogService = {
  /** `GET /admin/audit-logs` — one source at a time, newest first, paginated. */
  async list(query: AdminAuditLogQuery): Promise<Paginated<AdminAuditEntryDto>> {
    const range = zonedDayRange(query.from, query.to);
    const where: AuditWhere = {
      ...(query.action
        ? { action: query.action.endsWith('.') ? { startsWith: query.action } : query.action }
        : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(range ? { createdAt: range } : {}),
    };
    const { skip, take } = pageArgs(query);
    const args = {
      where,
      select: auditSelect,
      orderBy: [{ createdAt: 'desc' as const }, { id: 'asc' as const }],
      skip,
      take,
    };

    let rows: AuditRow[];
    let total: number;
    if (query.source === 'payment') {
      [rows, total] = await Promise.all([
        prisma.paymentAuditLog.findMany(args),
        prisma.paymentAuditLog.count({ where }),
      ]);
    } else if (query.source === 'assessment') {
      [rows, total] = await Promise.all([
        prisma.assessmentAuditLog.findMany(args),
        prisma.assessmentAuditLog.count({ where }),
      ]);
    } else {
      [rows, total] = await Promise.all([
        prisma.adminAuditLog.findMany(args),
        prisma.adminAuditLog.count({ where }),
      ]);
    }
    return paginated(
      rows.map((row) => toEntry(query.source, row)),
      total,
      query,
    );
  },

  /** Latest administrative entries for the dashboard. */
  async recent(take: number): Promise<AdminAuditEntryDto[]> {
    const rows = await prisma.adminAuditLog.findMany({
      select: auditSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take,
    });
    return rows.map((row) => toEntry('admin', row));
  },
};
