import type {
  AdminAnnouncementDetail,
  AdminAnnouncementItem,
  Paginated,
  PublicAnnouncementDto,
} from '@asra/types';
import {
  ANNOUNCEMENT_DEFAULTS,
  announcementSettingsSchema,
  type AdminAnnouncementListQuery,
  type AnnouncementCreateInput,
  type AnnouncementPriorityInput,
  type AnnouncementPublishInput,
  type AnnouncementScheduleInput,
  type AnnouncementSettingsInput,
  type AnnouncementUpdateInput,
  type PublicActiveAnnouncementsQuery,
} from '@asra/validation';
import { prisma } from '../../database/prisma.js';
import type { DbClient } from '../../database/types.js';
import type { AnnouncementStatus, Prisma } from '../../generated/prisma/client.js';
import { clock } from '../../lib/clock.js';
import { logger } from '../../lib/logger.js';
import type { AuthContext } from '../../types/auth.js';
import { AppError, fieldError } from '../../utils/app-error.js';
import { pageArgs, paginated } from '../../utils/pagination.js';
import { adminAudit } from '../admin/audit.js';
import {
  assertAttachable,
  mediaRefSelect,
  releaseMedia,
  toMediaDto,
  type MediaRef,
} from '../assessments/media/media.service.js';
import {
  getCachedAnnouncementCandidates,
  invalidateAnnouncementCache,
} from './announcements.cache.js';
import {
  isAnnouncementPubliclyEligible,
  resolveEffectiveAnnouncementStatus,
  resolveTargetAudiences,
  sortAnnouncementsByPriority,
  type CachedPublicCandidate,
} from './announcements.lifecycle.js';

const announcementInclude = {
  imageMedia: { select: mediaRefSelect },
  createdBy: { select: { id: true, fullName: true } },
  updatedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.AnnouncementInclude;

type AnnouncementRow = Prisma.AnnouncementGetPayload<{ include: typeof announcementInclude }>;

function notFound(): never {
  throw new AppError('NOT_FOUND', 'Announcement not found');
}

function asMediaRef(row: NonNullable<AnnouncementRow['imageMedia']>): MediaRef {
  return {
    id: row.id,
    publicId: row.publicId,
    format: row.format as MediaRef['format'],
    width: row.width,
    height: row.height,
  };
}

function toAdminDto(row: AnnouncementRow, now = clock.now()): AdminAnnouncementDetail {
  const effectiveStatus = resolveEffectiveAnnouncementStatus(
    { status: row.status, startsAt: row.startsAt, endsAt: row.endsAt },
    now,
  );
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    image: row.imageMedia ? toMediaDto(asMediaRef(row.imageMedia)) : null,
    displayType: row.displayType,
    ctaText: row.ctaText,
    redirectUrl: row.redirectUrl,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    displayDelaySeconds: row.displayDelaySeconds,
    frequency: row.frequency,
    priority: row.priority,
    audience: row.audience,
    status: effectiveStatus,
    storedStatus: row.status,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    pausedAt: row.pausedAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdBy: row.createdBy ? { id: row.createdBy.id, fullName: row.createdBy.fullName } : null,
    updatedBy: row.updatedBy ? { id: row.updatedBy.id, fullName: row.updatedBy.fullName } : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    serverNow: now.toISOString(),
  };
}

function settingsOf(row: AnnouncementRow): AnnouncementSettingsInput {
  return {
    title: row.title,
    description: row.description,
    imageMediaId: row.imageMediaId,
    displayType: row.displayType,
    ctaText: row.ctaText,
    redirectUrl: row.redirectUrl,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    displayDelaySeconds: row.displayDelaySeconds,
    frequency: row.frequency,
    priority: row.priority,
    audience: row.audience,
  };
}

function toWriteData(settings: AnnouncementSettingsInput) {
  return {
    title: settings.title,
    description: settings.description,
    imageMediaId: settings.imageMediaId,
    displayType: settings.displayType,
    ctaText: settings.ctaText,
    redirectUrl: settings.redirectUrl,
    startsAt: settings.startsAt ? new Date(settings.startsAt) : null,
    endsAt: settings.endsAt ? new Date(settings.endsAt) : null,
    displayDelaySeconds: settings.displayDelaySeconds,
    frequency: settings.frequency,
    priority: settings.priority,
    audience: settings.audience,
  };
}

async function lockRow(tx: DbClient, id: string): Promise<void> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"::text AS id FROM "announcements" WHERE "id" = ${id}::uuid FOR UPDATE
  `;
  if (locked.length === 0) notFound();
}

async function releaseMediaSafely(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await releaseMedia(ids).catch((error) =>
    logger.warn({ err: error, ids }, 'Announcement media cleanup failed; will retry later'),
  );
}

function statusFilterWhere(
  status: AnnouncementStatus | undefined,
  now: Date,
): Prisma.AnnouncementWhereInput {
  if (!status) return {};
  if (status === 'DRAFT' || status === 'PAUSED' || status === 'ARCHIVED') {
    return { status };
  }
  if (status === 'EXPIRED') {
    return {
      OR: [
        { status: 'EXPIRED' },
        { status: { in: ['PUBLISHED', 'SCHEDULED'] }, endsAt: { lte: now } },
      ],
    };
  }
  if (status === 'SCHEDULED') {
    return {
      status: { in: ['SCHEDULED', 'PUBLISHED'] },
      startsAt: { gt: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    };
  }
  return {
    status: { in: ['PUBLISHED', 'SCHEDULED'] },
    AND: [
      { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
      { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    ],
  };
}

function toPublicDto(candidate: CachedPublicCandidate): PublicAnnouncementDto {
  return {
    id: candidate.id,
    title: candidate.title,
    description: candidate.description,
    image: candidate.image,
    displayType: candidate.displayType,
    ctaText: candidate.ctaText,
    redirectUrl: candidate.redirectUrl,
    displayDelaySeconds: candidate.displayDelaySeconds,
    frequency: candidate.frequency,
    priority: candidate.priority,
    audience: candidate.audience,
    startsAt: candidate.startsAt,
    endsAt: candidate.endsAt,
  };
}

export const announcementsService = {
  /** Paginated admin listing with search, status, displayType, and audience filters. */
  async list(query: AdminAnnouncementListQuery): Promise<Paginated<AdminAnnouncementItem>> {
    const now = clock.now();
    const where: Prisma.AnnouncementWhereInput = {
      ...statusFilterWhere(query.status, now),
      ...(query.displayType ? { displayType: query.displayType } : {}),
      ...(query.audience ? { audience: query.audience } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { description: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const { skip, take } = pageArgs(query);
    const [rows, total] = await Promise.all([
      prisma.announcement.findMany({
        where,
        include: announcementInclude,
        orderBy: [
          { priority: 'desc' },
          { updatedAt: 'desc' },
          { createdAt: 'desc' },
          { id: 'asc' },
        ],
        skip,
        take,
      }),
      prisma.announcement.count({ where }),
    ]);
    return paginated(
      rows.map((row) => toAdminDto(row, now)),
      total,
      query,
    );
  },

  async get(id: string): Promise<AdminAnnouncementDetail> {
    const row = await prisma.announcement.findUnique({
      where: { id },
      include: announcementInclude,
    });
    if (!row) notFound();
    return toAdminDto(row, clock.now());
  },

  async create(
    auth: AuthContext,
    input: AnnouncementCreateInput,
  ): Promise<AdminAnnouncementDetail> {
    const now = clock.now();
    const defaultDelay =
      input.displayType === 'TOP_BANNER'
        ? ANNOUNCEMENT_DEFAULTS.displayDelaySeconds
        : ANNOUNCEMENT_DEFAULTS.displayDelaySeconds;
    const settings = announcementSettingsSchema.parse({
      ...ANNOUNCEMENT_DEFAULTS,
      displayDelaySeconds:
        input.displayDelaySeconds ?? (input.displayType === 'TOP_BANNER' ? 0 : defaultDelay),
      ...input,
    });

    const created = await prisma.$transaction(async (tx) => {
      if (settings.imageMediaId) {
        await assertAttachable(tx, auth, [settings.imageMediaId]);
      }
      const row = await tx.announcement.create({
        data: {
          ...toWriteData(settings),
          status: 'DRAFT',
          createdById: auth.userId,
          updatedById: auth.userId,
        },
        include: announcementInclude,
      });
      await adminAudit(tx, {
        action: 'announcement.created',
        actorId: auth.userId,
        entityType: 'announcement',
        entityId: row.id,
        data: {
          title: row.title,
          displayType: row.displayType,
          audience: row.audience,
        },
      });
      return row;
    });

    return toAdminDto(created, now);
  },

  async update(
    auth: AuthContext,
    id: string,
    input: AnnouncementUpdateInput,
  ): Promise<AdminAnnouncementDetail> {
    const now = clock.now();
    const { row, removedMediaId } = await prisma.$transaction(async (tx) => {
      await lockRow(tx, id);
      const current = await tx.announcement.findUnique({
        where: { id },
        include: announcementInclude,
      });
      if (!current) notFound();

      if (current.status === 'ARCHIVED') {
        throw new AppError(
          'CONFLICT',
          'Archived announcements must be restored to draft before editing.',
        );
      }

      const merged = announcementSettingsSchema.parse({
        ...settingsOf(current),
        ...input,
      });

      const alreadyAttached = new Set(current.imageMediaId ? [current.imageMediaId] : []);
      if (merged.imageMediaId) {
        await assertAttachable(tx, auth, [merged.imageMediaId], alreadyAttached);
      }

      const removed =
        current.imageMediaId && current.imageMediaId !== merged.imageMediaId
          ? current.imageMediaId
          : null;

      // If an active/scheduled/expired campaign gets extended/edited, keep lifecycle consistent.
      const startsAt = merged.startsAt ? new Date(merged.startsAt) : null;
      const endsAt = merged.endsAt ? new Date(merged.endsAt) : null;
      let nextStatus = current.status;
      if (
        current.status === 'PUBLISHED' ||
        current.status === 'SCHEDULED' ||
        current.status === 'EXPIRED'
      ) {
        if (endsAt && endsAt.getTime() <= now.getTime()) {
          nextStatus = 'EXPIRED';
        } else if (startsAt && startsAt.getTime() > now.getTime()) {
          nextStatus = 'SCHEDULED';
        } else if (current.status !== 'EXPIRED') {
          nextStatus = 'PUBLISHED';
        }
      }

      const updated = await tx.announcement.update({
        where: { id },
        data: {
          ...toWriteData(merged),
          status: nextStatus,
          updatedById: auth.userId,
        },
        include: announcementInclude,
      });

      await adminAudit(tx, {
        action: 'announcement.updated',
        actorId: auth.userId,
        entityType: 'announcement',
        entityId: id,
        data: { fields: Object.keys(input) },
      });

      return { row: updated, removedMediaId: removed };
    });

    if (removedMediaId) {
      await releaseMediaSafely([removedMediaId]);
    }
    await invalidateAnnouncementCache();
    return toAdminDto(row, now);
  },

  async updatePriority(
    auth: AuthContext,
    id: string,
    input: AnnouncementPriorityInput,
  ): Promise<AdminAnnouncementDetail> {
    const now = clock.now();
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, id);
      const current = await tx.announcement.findUnique({
        where: { id },
        select: { priority: true },
      });
      if (!current) notFound();
      const updated = await tx.announcement.update({
        where: { id },
        data: { priority: input.priority, updatedById: auth.userId },
        include: announcementInclude,
      });
      await adminAudit(tx, {
        action: 'announcement.priority_updated',
        actorId: auth.userId,
        entityType: 'announcement',
        entityId: id,
        data: { previous: current.priority, next: input.priority },
      });
      return updated;
    });
    await invalidateAnnouncementCache();
    return toAdminDto(row, now);
  },

  async publish(
    auth: AuthContext,
    id: string,
    input: AnnouncementPublishInput = {},
  ): Promise<AdminAnnouncementDetail> {
    const now = clock.now();
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, id);
      const current = await tx.announcement.findUnique({ where: { id } });
      if (!current) notFound();

      if (current.status === 'ARCHIVED') {
        throw new AppError(
          'CONFLICT',
          'Restore an archived announcement to draft before publishing.',
        );
      }
      if (current.endsAt && current.endsAt.getTime() <= now.getTime()) {
        throw fieldError(
          'VALIDATION_ERROR',
          'endsAt',
          'End date and time has already passed. Extend it before publishing.',
        );
      }

      const startsInFuture = Boolean(
        !input.immediate && current.startsAt && current.startsAt.getTime() > now.getTime(),
      );
      const nextStartsAt =
        input.immediate && current.startsAt && current.startsAt.getTime() > now.getTime()
          ? now
          : current.startsAt;
      const nextStatus: AnnouncementStatus = startsInFuture ? 'SCHEDULED' : 'PUBLISHED';

      const updated = await tx.announcement.update({
        where: { id },
        data: {
          status: nextStatus,
          startsAt: nextStartsAt,
          publishedAt: current.publishedAt ?? now,
          pausedAt: null,
          updatedById: auth.userId,
        },
        include: announcementInclude,
      });

      await adminAudit(tx, {
        action: nextStatus === 'SCHEDULED' ? 'announcement.scheduled' : 'announcement.published',
        actorId: auth.userId,
        entityType: 'announcement',
        entityId: id,
        data: { startsAt: nextStartsAt?.toISOString() ?? null },
      });
      return updated;
    });

    await invalidateAnnouncementCache();
    return toAdminDto(row, now);
  },

  async schedule(
    auth: AuthContext,
    id: string,
    input: AnnouncementScheduleInput = {},
  ): Promise<AdminAnnouncementDetail> {
    const now = clock.now();
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, id);
      const current = await tx.announcement.findUnique({ where: { id } });
      if (!current) notFound();

      if (current.status === 'ARCHIVED') {
        throw new AppError('CONFLICT', 'Restore an archived announcement before scheduling.');
      }

      const startsAt = input.startsAt !== undefined ? new Date(input.startsAt) : current.startsAt;
      const endsAt =
        input.endsAt !== undefined
          ? input.endsAt
            ? new Date(input.endsAt)
            : null
          : current.endsAt;

      if (!startsAt) {
        throw fieldError('VALIDATION_ERROR', 'startsAt', 'Choose a future start date and time.');
      }
      if (startsAt.getTime() <= now.getTime()) {
        throw fieldError(
          'VALIDATION_ERROR',
          'startsAt',
          'Scheduled start date and time must be in the future.',
        );
      }
      if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
        throw fieldError(
          'VALIDATION_ERROR',
          'endsAt',
          'End date and time must be after start date and time.',
        );
      }

      const updated = await tx.announcement.update({
        where: { id },
        data: {
          status: 'SCHEDULED',
          startsAt,
          endsAt,
          pausedAt: null,
          updatedById: auth.userId,
        },
        include: announcementInclude,
      });

      await adminAudit(tx, {
        action: 'announcement.scheduled',
        actorId: auth.userId,
        entityType: 'announcement',
        entityId: id,
        data: { startsAt: startsAt.toISOString(), endsAt: endsAt?.toISOString() ?? null },
      });
      return updated;
    });

    await invalidateAnnouncementCache();
    return toAdminDto(row, now);
  },

  async pause(auth: AuthContext, id: string): Promise<AdminAnnouncementDetail> {
    const now = clock.now();
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, id);
      const current = await tx.announcement.findUnique({ where: { id } });
      if (!current) notFound();

      const effective = resolveEffectiveAnnouncementStatus(current, now);
      if (effective !== 'PUBLISHED' && effective !== 'SCHEDULED') {
        throw new AppError('CONFLICT', 'Only published or scheduled announcements can be paused.');
      }

      const updated = await tx.announcement.update({
        where: { id },
        data: {
          status: 'PAUSED',
          pausedAt: now,
          updatedById: auth.userId,
        },
        include: announcementInclude,
      });

      await adminAudit(tx, {
        action: 'announcement.paused',
        actorId: auth.userId,
        entityType: 'announcement',
        entityId: id,
      });
      return updated;
    });

    await invalidateAnnouncementCache();
    return toAdminDto(row, now);
  },

  async resume(auth: AuthContext, id: string): Promise<AdminAnnouncementDetail> {
    const now = clock.now();
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, id);
      const current = await tx.announcement.findUnique({ where: { id } });
      if (!current) notFound();

      if (current.status !== 'PAUSED') {
        throw new AppError('CONFLICT', 'Only paused announcements can be resumed.');
      }
      if (current.endsAt && current.endsAt.getTime() <= now.getTime()) {
        throw fieldError(
          'VALIDATION_ERROR',
          'endsAt',
          'End date and time has already passed. Extend it before resuming.',
        );
      }

      const nextStatus: AnnouncementStatus =
        current.startsAt && current.startsAt.getTime() > now.getTime() ? 'SCHEDULED' : 'PUBLISHED';

      const updated = await tx.announcement.update({
        where: { id },
        data: {
          status: nextStatus,
          pausedAt: null,
          publishedAt: current.publishedAt ?? now,
          updatedById: auth.userId,
        },
        include: announcementInclude,
      });

      await adminAudit(tx, {
        action: 'announcement.resumed',
        actorId: auth.userId,
        entityType: 'announcement',
        entityId: id,
        data: { status: nextStatus },
      });
      return updated;
    });

    await invalidateAnnouncementCache();
    return toAdminDto(row, now);
  },

  async archive(auth: AuthContext, id: string): Promise<AdminAnnouncementDetail> {
    const now = clock.now();
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, id);
      const current = await tx.announcement.findUnique({ where: { id } });
      if (!current) notFound();

      if (current.status === 'ARCHIVED') {
        throw new AppError('CONFLICT', 'Announcement is already archived.');
      }

      const updated = await tx.announcement.update({
        where: { id },
        data: {
          status: 'ARCHIVED',
          archivedAt: now,
          updatedById: auth.userId,
        },
        include: announcementInclude,
      });

      await adminAudit(tx, {
        action: 'announcement.archived',
        actorId: auth.userId,
        entityType: 'announcement',
        entityId: id,
      });
      return updated;
    });

    await invalidateAnnouncementCache();
    return toAdminDto(row, now);
  },

  async restore(auth: AuthContext, id: string): Promise<AdminAnnouncementDetail> {
    const now = clock.now();
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, id);
      const current = await tx.announcement.findUnique({ where: { id } });
      if (!current) notFound();

      if (current.status !== 'ARCHIVED') {
        throw new AppError('CONFLICT', 'Only archived announcements can be restored.');
      }

      const updated = await tx.announcement.update({
        where: { id },
        data: {
          status: 'DRAFT',
          archivedAt: null,
          pausedAt: null,
          updatedById: auth.userId,
        },
        include: announcementInclude,
      });

      await adminAudit(tx, {
        action: 'announcement.restored',
        actorId: auth.userId,
        entityType: 'announcement',
        entityId: id,
      });
      return updated;
    });

    await invalidateAnnouncementCache();
    return toAdminDto(row, now);
  },

  async remove(auth: AuthContext, id: string): Promise<void> {
    const now = clock.now();
    const mediaId = await prisma.$transaction(async (tx) => {
      await lockRow(tx, id);
      const current = await tx.announcement.findUnique({ where: { id } });
      if (!current) notFound();

      const effective = resolveEffectiveAnnouncementStatus(current, now);
      if (effective === 'PUBLISHED' || effective === 'SCHEDULED') {
        throw new AppError('CONFLICT', 'Pause or archive this announcement before deleting it.');
      }

      await tx.announcement.delete({ where: { id } });
      await adminAudit(tx, {
        action: 'announcement.deleted',
        actorId: auth.userId,
        entityType: 'announcement',
        entityId: id,
        data: { title: current.title },
      });
      return current.imageMediaId;
    });

    if (mediaId) {
      await releaseMediaSafely([mediaId]);
    }
    await invalidateAnnouncementCache();
  },

  /**
   * Public active-announcements lookup.
   * Reads only PUBLISHED/SCHEDULED candidates through the invalidated cache, filters strictly at
   * server instant `clock.now()`, checks audience + displayType, sorts by priority descending,
   * and returns sanitized public DTOs without internal metadata.
   */
  async listActive(query: PublicActiveAnnouncementsQuery): Promise<PublicAnnouncementDto[]> {
    const now = clock.now();
    const candidates = await getCachedAnnouncementCandidates(async () => {
      const rows = await prisma.announcement.findMany({
        where: {
          status: { in: ['PUBLISHED', 'SCHEDULED'] },
        },
        select: {
          id: true,
          title: true,
          description: true,
          displayType: true,
          ctaText: true,
          redirectUrl: true,
          displayDelaySeconds: true,
          frequency: true,
          priority: true,
          audience: true,
          status: true,
          startsAt: true,
          endsAt: true,
          publishedAt: true,
          createdAt: true,
          imageMedia: { select: mediaRefSelect },
        },
        orderBy: [
          { priority: 'desc' },
          { publishedAt: 'desc' },
          { createdAt: 'desc' },
          { id: 'asc' },
        ],
      });

      return rows.map((row) => {
        const media = row.imageMedia ? toMediaDto(asMediaRef(row.imageMedia)) : null;
        return {
          id: row.id,
          title: row.title,
          description: row.description,
          image: media ? { url: media.url, width: media.width, height: media.height } : null,
          displayType: row.displayType,
          ctaText: row.ctaText,
          redirectUrl: row.redirectUrl,
          displayDelaySeconds: row.displayDelaySeconds,
          frequency: row.frequency,
          priority: row.priority,
          audience: row.audience,
          status: row.status,
          startsAt: row.startsAt?.toISOString() ?? null,
          endsAt: row.endsAt?.toISOString() ?? null,
          publishedAt: row.publishedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        };
      });
    });

    const audiences = new Set(resolveTargetAudiences(query));
    const eligible = candidates.filter((item) => {
      if (!isAnnouncementPubliclyEligible(item, now)) return false;
      if (!audiences.has(item.audience)) return false;
      if (query.displayType && item.displayType !== query.displayType) return false;
      return true;
    });

    return sortAnnouncementsByPriority(eligible).map(toPublicDto);
  },
};
