import { randomUUID } from 'node:crypto';
import type { MediaDto, MediaUploadDto } from '@asra/types';
import { MEDIA_LIMITS, type MediaFormat } from '@asra/validation';
import { prisma } from '../../../database/prisma.js';
import type { DbClient } from '../../../database/types.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { clock } from '../../../lib/clock.js';
import { logger } from '../../../lib/logger.js';
import type { AuthContext } from '../../../types/auth.js';
import { AppError } from '../../../utils/app-error.js';
import { withTimeout } from '../../../utils/with-timeout.js';
import { imageStore } from './image-store.js';
import { MIME_BY_FORMAT, sniffImage } from './image-sniff.js';

/**
 * Question/option images shared by course quizzes, examinations and academy quizzes
 * (docs/ASSESSMENTS.md §Media).
 *
 *   upload  → bytes validated (real format, ≤ 100 KB, ≤ 2048 px, not animated) → Cloudinary →
 *             ledger row ACTIVE, owned by the uploader, referenced by nothing yet
 *   attach  → a question save may reference ACTIVE media uploaded by the caller, or media already
 *             on that question (row locked FOR SHARE, so it cannot start deleting meanwhile)
 *   release → ids a save/delete removed are deleted at once IF nothing references them any more
 *
 * "Referenced" = used by any question, option, historical attempt snapshot (attempt_questions.
 * media_ids), academy quiz banner or prize. Deletion is two-step and race-free: under FOR UPDATE
 * the row is re-checked and marked DELETING (no longer attachable), the file is destroyed after
 * commit, and only then is the row removed. Failures stay DELETING and are retried. There is no
 * scheduler: abandoned uploads (> 24 h, unreferenced) and failed deletions are collected a few at a
 * time whenever anyone uploads.
 */

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const COLLECT_BATCH = 5;
const COLLECT_TIMEOUT_MS = 4000;

export const MEDIA_FOLDER = 'asra/assessments';

const MIME_TO_FORMAT = new Map<string, MediaFormat>(
  (Object.entries(MIME_BY_FORMAT) as [MediaFormat, string][]).map(([format, mime]) => [
    mime,
    format,
  ]),
);

export interface MediaRef {
  id: string;
  publicId: string;
  format: MediaFormat;
  width: number;
  height: number;
}

export const mediaRefSelect = {
  id: true,
  publicId: true,
  format: true,
  width: true,
  height: true,
} satisfies Prisma.AssessmentMediaSelect;

export function toMediaDto(ref: MediaRef): MediaDto {
  return {
    id: ref.id,
    url: imageStore().url(ref.publicId, ref.format),
    width: ref.width,
    height: ref.height,
  };
}

/** Loads media refs by id (one query); unknown ids are simply absent from the map. */
export async function loadMediaRefs(
  db: DbClient,
  ids: Iterable<string>,
): Promise<Map<string, MediaRef>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.assessmentMedia.findMany({
    where: { id: { in: unique } },
    select: mediaRefSelect,
  });
  return new Map(rows.map((row) => [row.id, { ...row, format: row.format as MediaFormat }]));
}

/** Of `ids`, those still used anywhere (see the module comment). One round trip. */
export async function referencedMediaIds(db: DbClient, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT x.id::text AS id
      FROM unnest(${ids}::uuid[]) AS x(id)
     WHERE EXISTS (SELECT 1 FROM "assessment_questions" q WHERE q."image_ids" @> ARRAY[x.id])
        OR EXISTS (SELECT 1 FROM "assessment_question_options" o WHERE o."image_id" = x.id)
        OR EXISTS (SELECT 1 FROM "attempt_questions" a WHERE a."media_ids" @> ARRAY[x.id])
        OR EXISTS (SELECT 1 FROM "academy_quizzes" z WHERE z."banner_media_id" = x.id)
        OR EXISTS (
             SELECT 1 FROM "academy_quizzes" z
              WHERE z."prizes" @> jsonb_build_array(jsonb_build_object('imageMediaId', x.id::text)))`;
  return new Set(rows.map((row) => row.id));
}

/**
 * Verifies a save may reference `ids` and locks them FOR SHARE until the transaction ends.
 * Allowed: ACTIVE media uploaded by the caller, or media in `alreadyAttached` (what the target
 * already used before this save — e.g. images a co-teacher added). Everything else is refused
 * without revealing whether the id exists.
 */
export async function assertAttachable(
  tx: DbClient,
  auth: AuthContext,
  ids: string[],
  alreadyAttached: ReadonlySet<string> = new Set(),
): Promise<Map<string, MediaRef>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await tx.$queryRaw<
    {
      id: string;
      public_id: string;
      format: string;
      width: number;
      height: number;
      status: string;
      uploaded_by_id: string | null;
    }[]
  >`SELECT "id"::text AS id, "public_id", "format", "width", "height", "status", "uploaded_by_id"::text
      FROM "assessment_media" WHERE "id" = ANY(${unique}::uuid[]) FOR SHARE`;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const refs = new Map<string, MediaRef>();
  for (const id of unique) {
    const row = byId.get(id);
    const allowed =
      row &&
      row.status === 'ACTIVE' &&
      (row.uploaded_by_id === auth.userId || alreadyAttached.has(id));
    if (!allowed) {
      throw new AppError(
        'VALIDATION_ERROR',
        'One of the images is no longer available. Remove it and upload it again.',
        [{ path: ['imageIds'], message: 'Upload the image again' }],
      );
    }
    refs.set(id, {
      id,
      publicId: row.public_id,
      format: row.format as MediaFormat,
      width: row.width,
      height: row.height,
    });
  }
  return refs;
}

/**
 * Deletes, from the ledger and Cloudinary, those of `ids` that nothing references. Safe to call
 * with any ids (referenced ones are kept) and concurrently (rows are claimed with SKIP LOCKED).
 * Call it AFTER the transaction that removed the references has committed.
 */
export async function releaseMedia(ids: Iterable<string>): Promise<number> {
  const candidates = [...new Set(ids)];
  if (candidates.length === 0) return 0;
  const claimed = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; public_id: string }[]>`
      SELECT "id"::text AS id, "public_id" FROM "assessment_media"
       WHERE "id" = ANY(${candidates}::uuid[]) FOR UPDATE SKIP LOCKED`;
    if (locked.length === 0) return [];
    const stillUsed = await referencedMediaIds(
      tx,
      locked.map((row) => row.id),
    );
    const doomed = locked.filter((row) => !stillUsed.has(row.id));
    if (doomed.length > 0) {
      await tx.assessmentMedia.updateMany({
        where: { id: { in: doomed.map((row) => row.id) } },
        data: { status: 'DELETING' },
      });
    }
    return doomed;
  });
  let deleted = 0;
  for (const row of claimed) {
    try {
      await imageStore().destroy(row.public_id);
      await prisma.assessmentMedia.deleteMany({ where: { id: row.id, status: 'DELETING' } });
      deleted += 1;
    } catch (error) {
      // Stays DELETING (never attachable again) and is retried by `collectGarbage`.
      await prisma.assessmentMedia
        .updateMany({ where: { id: row.id }, data: { deleteAttempts: { increment: 1 } } })
        .catch(() => undefined);
      logger.warn({ mediaId: row.id, err: error }, 'Image deletion failed; will retry later');
    }
  }
  return deleted;
}

/**
 * Opportunistic cleanup (no scheduler): retries failed deletions and removes uploads that were
 * never used within 24 h. Bounded in size and time so it never slows a request noticeably.
 */
export async function collectGarbage(now = clock.now(), batch = COLLECT_BATCH): Promise<number> {
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);
  const rows = await prisma.assessmentMedia.findMany({
    where: {
      OR: [{ status: 'DELETING' }, { status: 'ACTIVE', createdAt: { lt: staleBefore } }],
    },
    orderBy: [{ status: 'desc' }, { createdAt: 'asc' }],
    select: { id: true },
    take: batch * 4,
  });
  if (rows.length === 0) return 0;
  const used = await referencedMediaIds(
    prisma,
    rows.map((row) => row.id),
  );
  const unused = rows.filter((row) => !used.has(row.id)).slice(0, batch);
  return releaseMedia(unused.map((row) => row.id));
}

/** Ids of the caller's uploads that no question/quiz uses yet (newest first). */
async function pendingUploadCount(userId: string): Promise<number> {
  const recent = await prisma.assessmentMedia.findMany({
    where: { uploadedById: userId, status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
    take: MEDIA_LIMITS.maxPendingPerUser * 4,
  });
  const used = await referencedMediaIds(
    prisma,
    recent.map((row) => row.id),
  );
  return recent.filter((row) => !used.has(row.id)).length;
}

export function validateImage(buffer: Buffer, contentType: string | undefined) {
  if (buffer.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Choose an image to upload.');
  }
  if (buffer.length > MEDIA_LIMITS.maxBytes) {
    throw new AppError(
      'VALIDATION_ERROR',
      `The image is ${Math.ceil(buffer.length / 1024)} KB; the maximum is ${MEDIA_LIMITS.maxBytes / 1024} KB.`,
    );
  }
  const declared = MIME_TO_FORMAT.get((contentType ?? '').split(';')[0]!.trim().toLowerCase());
  const sniffed = sniffImage(buffer);
  if (!sniffed || !declared) {
    throw new AppError('VALIDATION_ERROR', 'Only WebP, JPEG or PNG images can be uploaded.');
  }
  if (sniffed.format !== declared) {
    throw new AppError('VALIDATION_ERROR', 'The file content does not match its image type.');
  }
  if (sniffed.animated) {
    throw new AppError('VALIDATION_ERROR', 'Animated images are not supported.');
  }
  if (sniffed.width > MEDIA_LIMITS.maxDimension || sniffed.height > MEDIA_LIMITS.maxDimension) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Images can be at most ${MEDIA_LIMITS.maxDimension} × ${MEDIA_LIMITS.maxDimension} pixels.`,
    );
  }
  return sniffed;
}

export const mediaService = {
  /** Validates and stores one optimized image for the caller (authorization is route-level). */
  async upload(
    auth: AuthContext,
    buffer: Buffer,
    contentType: string | undefined,
  ): Promise<MediaUploadDto> {
    const image = validateImage(buffer, contentType);
    if ((await pendingUploadCount(auth.userId)) >= MEDIA_LIMITS.maxPendingPerUser) {
      throw new AppError(
        'CONFLICT',
        'You have many uploaded images that are not used in any question yet. Save or discard your current questions first.',
      );
    }
    const publicId = `${MEDIA_FOLDER}/${randomUUID()}`;
    await imageStore().upload({ publicId, format: image.format, buffer });
    let row;
    try {
      row = await prisma.assessmentMedia.create({
        data: {
          publicId,
          // Same clock as `collectGarbage` (never mix the database clock with the server clock).
          createdAt: clock.now(),
          uploadedById: auth.userId,
          format: image.format,
          bytes: buffer.length,
          width: image.width,
          height: image.height,
        },
        select: mediaRefSelect,
      });
    } catch (error) {
      await imageStore()
        .destroy(publicId)
        .catch(() => undefined);
      throw error;
    }
    // Piggy-backed, bounded cleanup of abandoned uploads / failed deletions.
    await withTimeout(collectGarbage(), COLLECT_TIMEOUT_MS, 'media cleanup').catch((error) =>
      logger.warn({ err: error }, 'Opportunistic media cleanup skipped'),
    );
    return {
      ...toMediaDto({ ...row, format: image.format }),
      bytes: buffer.length,
      format: image.format,
    };
  },
};
