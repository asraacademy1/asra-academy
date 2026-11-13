import crypto from 'node:crypto';
import {
  PERMISSIONS,
  type AdminCertificateListItem,
  type CertificateAuditLogItemDto,
  type CertificateDto,
  type CertificateEligibilityResult,
  type CertificateIneligibilityReason,
  type CertificateOverviewStatsDto,
  type CertificateSettingsDto,
  type CertificateSignatureSnapshotDto,
  type CertificateSourceOptionDto,
  type CertificateSourceType,
  type CertificateStudentLookupDto,
  type CertificateTemplateSnapshotDto,
  type Paginated,
  type PublicCertificateVerificationDto,
} from '@asra/types';
import {
  CERTIFICATE_SIGNATURE_LIMITS,
  isArtworkCertificateStyle,
  SOURCE_TYPE_LABELS,
  type AdminCertificateQuery,
  type CertificateAuditQuery,
  type CertificateSignaturePlacementInput,
  type CertificateStudentSearchQuery,
  type GenericCertificateIssueInput,
  type ManualCertificateIssueInput,
  type ReissueCertificateInput,
  type StudentCertificateQuery,
  type UpdateCertificateSettingsInput,
} from '@asra/validation';
import { prisma } from '../../database/prisma.js';
import type { DbClient } from '../../database/types.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { clock } from '../../lib/clock.js';
import { logger } from '../../lib/logger.js';
import type { AuthContext } from '../../types/auth.js';
import { AppError, fieldError } from '../../utils/app-error.js';
import { pageArgs, paginated } from '../../utils/pagination.js';
import { resultsReleased } from '../academy-quizzes/timing.js';
import { adminAudit } from '../admin/audit.js';
import { dispatchAfterCommit } from '../notifications/dispatcher.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { calculateCourseProgress, isCourseComplete } from '../student/progress.js';
import { toCourseView } from '../student/student.mappers.js';
import { createStudentRepository } from '../student/student.repository.js';
import {
  buildVerificationUrl,
  DEFAULT_FALLBACK_SIGNATURES,
  ensureCertificateDefaults,
  hydrateSignatureSnapshots,
  normalizeTemplateConfig,
  parseTemplateSnapshot,
  recordCertificateAudit,
  resolveCertificateLifecycleStatus,
  resolveCertificateSignatureSnapshots,
  toAdminCertificateListItem,
  toCertificateDto,
  toSettingsDto,
  type CertificateWithReissues,
} from './bootstrap.js';
import { generateCertificateNumber } from './id-generator.js';
import { generateCertificatePdf as renderPdf } from './pdf.service.js';
import { generateCertificatePng as renderPng } from './png.service.js';
import { certificateStorage } from './storage.service.js';
import {
  artworkSignatureRequirementMessage,
  assertTemplateSignatureRequirement,
  isRetiredTemplateKey,
  requiredSignatureCountForStyle,
} from './template-rules.js';
import { lockSignatureRows, validateAndBuildSignatureSnapshots } from './templates.service.js';

export interface IssueCertificateEngineInput {
  sourceType: CertificateSourceType;
  sourceReferenceId?: string | null;
  sourceLabel?: string | null;
  userId?: string | null;
  enrollmentId?: string | null;
  courseId?: string | null;
  academyQuizId?: string | null;
  examinationId?: string | null;
  recipientName: string;
  recipientEmail?: string | null;
  recipientStudentCode?: string | null;
  templateId?: string | null;
  certificateTitle?: string | null;
  subjectTitle: string;
  description?: string | null;
  achievementDetails?: string | null;
  completedAt?: Date;
  issuedAt?: Date;
  idempotencyKey?: string | null;
  signatures?: CertificateSignaturePlacementInput[];
  requireExplicitSignatures?: boolean;
  reissuedFromId?: string | null;
  metadata?: Record<string, unknown> | null;
  adminActorId?: string | null;
  notificationMessage?: string;
  visibleInStudentDashboard?: boolean;
  certificateCategory?: string | null;
  quizRank?: number | null;
  quizAttemptId?: string | null;
  issuedFormats?: ('PDF' | 'PNG')[];
  skipNotification?: boolean;
  skipEmailNotification?: boolean;
  /** Pre-allocated certificate number & snapshots when pre-rendered/verified before commit. */
  preallocatedCertificateNumber?: string;
  precomputedSnapshots?: {
    templateId: string;
    templateSnapshot: CertificateTemplateSnapshotDto;
    signatureSnapshots: CertificateSignatureSnapshotDto[];
  };
}

async function lockIdempotencyKey(tx: DbClient, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('asra_cert_idem'), hashtext(${key}))`;
}

function assertValidSignatureSnapshots(snapshots: CertificateSignatureSnapshotDto[]): void {
  if (
    snapshots.length < CERTIFICATE_SIGNATURE_LIMITS.minSignatures ||
    snapshots.length > CERTIFICATE_SIGNATURE_LIMITS.maxSignatures
  ) {
    throw fieldError(
      'VALIDATION_ERROR',
      'signatures',
      `Certificates require between ${CERTIFICATE_SIGNATURE_LIMITS.minSignatures} and ${CERTIFICATE_SIGNATURE_LIMITS.maxSignatures} signatories.`,
    );
  }
  const seenIds = new Set<string>();
  const seenOrders = new Set<number>();
  for (const snap of snapshots) {
    if (!snap.isFallback && snap.signatureId) {
      if (seenIds.has(snap.signatureId)) {
        throw fieldError(
          'VALIDATION_ERROR',
          'signatures',
          'The same signature cannot be selected twice on a single certificate.',
        );
      }
      seenIds.add(snap.signatureId);
    }
    if (seenOrders.has(snap.sortOrder)) {
      throw fieldError('VALIDATION_ERROR', 'signatures', 'Signature positions must be unique.');
    }
    seenOrders.add(snap.sortOrder);
  }
}

export async function allocateCertificateNumber(tx: DbClient, year: number): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateCertificateNumber(year);
    const taken = await tx.certificate.findUnique({
      where: { certificateNumber: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  throw new AppError('INTERNAL_ERROR', 'Failed to allocate unique certificate number');
}

export async function resolveTemplateAndSnapshots(
  tx: DbClient,
  input: {
    templateId?: string | null;
    certificateTitle?: string | null;
    description?: string | null;
    signatures?: CertificateSignaturePlacementInput[];
    requireExplicitSignatures?: boolean;
  },
): Promise<{
  templateId: string;
  templateSnapshot: CertificateTemplateSnapshotDto;
  signatureSnapshots: CertificateSignatureSnapshotDto[];
}> {
  await ensureCertificateDefaults(tx);
  const settings = await tx.certificateSettings.findUnique({ where: { id: 'default' } });

  const requestedTemplateId = input.templateId ?? settings?.defaultTemplateId ?? null;
  let template = requestedTemplateId
    ? await tx.certificateTemplate.findUnique({
        where: { id: requestedTemplateId },
        include: {
          signatures: {
            include: { signature: true },
            orderBy: { sortOrder: 'asc' },
          },
        },
      })
    : null;

  if (input.templateId && (!template || !template.isActive)) {
    throw fieldError(
      'VALIDATION_ERROR',
      'templateId',
      template ? 'Selected template is inactive.' : 'Selected certificate template was not found.',
    );
  }

  if (!template || !template.isActive) {
    template =
      (await tx.certificateTemplate.findFirst({
        where: { isDefault: true, isActive: true },
        include: {
          signatures: {
            include: { signature: true },
            orderBy: { sortOrder: 'asc' },
          },
        },
      })) ??
      (await tx.certificateTemplate.findFirst({
        where: { isActive: true },
        include: {
          signatures: {
            include: { signature: true },
            orderBy: { sortOrder: 'asc' },
          },
        },
      }));
  }

  if (!template) {
    throw new AppError('INTERNAL_ERROR', 'No active certificate template is available');
  }

  if (isRetiredTemplateKey(template.key)) {
    throw fieldError(
      'VALIDATION_ERROR',
      'templateId',
      `Template "${template.name}" has been archived and cannot be used for new certificates.`,
    );
  }

  const baseConfig = normalizeTemplateConfig(template.config);
  // Artwork templates: the heading is part of the approved artwork and the statement always
  // comes from the template body ({title}/{date} placeholders) — per-call overrides are ignored.
  const isArtwork = isArtworkCertificateStyle(template.style);

  const templateSnapshot: CertificateTemplateSnapshotDto = {
    templateId: template.id,
    key: template.key,
    name: template.name,
    style: template.style,
    version: template.version,
    certificateTitle: isArtwork
      ? template.defaultTitle
      : input.certificateTitle?.trim() || template.defaultTitle,
    subtitle: settings?.academyTagline ?? template.defaultSubtitle,
    bodyText: isArtwork
      ? template.defaultBodyText
      : input.description?.trim() || template.defaultBodyText,
    issuingAuthority: settings?.academyName ?? template.issuingAuthority,
    config: {
      ...baseConfig,
      showQrCode: true,
    },
  };

  let signatureSnapshots: CertificateSignatureSnapshotDto[];
  if (input.signatures !== undefined) {
    signatureSnapshots = await validateAndBuildSignatureSnapshots(tx, input.signatures);
  } else {
    const configured = [...template.signatures].sort((a, b) => a.sortOrder - b.sortOrder);

    if (configured.length > 0) {
      await lockSignatureRows(
        tx,
        configured.map((l) => l.signatureId),
      );
      const freshRows = await tx.certificateSignature.findMany({
        where: { id: { in: configured.map((l) => l.signatureId) } },
      });
      const freshById = new Map(freshRows.map((r) => [r.id, r]));
      const activeConfigured = configured.filter(
        (link) => freshById.get(link.signatureId)?.isActive,
      );

      const requiredCount = requiredSignatureCountForStyle(template.style);
      if (
        requiredCount !== null &&
        (configured.length !== requiredCount || activeConfigured.length !== requiredCount)
      ) {
        // An inactive configured signatory is never silently replaced by another one.
        throw fieldError(
          'VALIDATION_ERROR',
          'signatures',
          artworkSignatureRequirementMessage(template.name, template.style),
        );
      }

      if (
        activeConfigured.length < CERTIFICATE_SIGNATURE_LIMITS.minSignatures ||
        activeConfigured.length > CERTIFICATE_SIGNATURE_LIMITS.maxSignatures
      ) {
        throw fieldError(
          'VALIDATION_ERROR',
          'signatures',
          `Template "${template.name}" must have between ${CERTIFICATE_SIGNATURE_LIMITS.minSignatures} and ${CERTIFICATE_SIGNATURE_LIMITS.maxSignatures} active digital signatures configured before certificates can be issued.`,
        );
      }

      signatureSnapshots = activeConfigured.map((link) => {
        const sig = freshById.get(link.signatureId)!;
        return {
          signatureId: sig.id,
          fullName: sig.fullName,
          designation: sig.designation,
          department: sig.department,
          positionLabel: link.positionLabel,
          sortOrder: link.sortOrder,
          showName: link.showName,
          showDesignation: link.showDesignation,
          storageProvider: sig.storageProvider,
          storageKey: sig.storageKey,
          imageUrl: sig.imageUrl,
          width: sig.width,
          height: sig.height,
          isFallback: false,
        };
      });
    } else if (input.requireExplicitSignatures) {
      throw fieldError(
        'VALIDATION_ERROR',
        'signatures',
        `Select between ${CERTIFICATE_SIGNATURE_LIMITS.minSignatures} and ${CERTIFICATE_SIGNATURE_LIMITS.maxSignatures} active digital signatures for this certificate.`,
      );
    } else if (requiredSignatureCountForStyle(template.style) !== null) {
      // Mandatory-signature templates never fall back to placeholder signatories.
      throw fieldError(
        'VALIDATION_ERROR',
        'signatures',
        artworkSignatureRequirementMessage(template.name, template.style),
      );
    } else {
      signatureSnapshots = DEFAULT_FALLBACK_SIGNATURES;
    }
  }

  assertTemplateSignatureRequirement(template, signatureSnapshots);
  assertValidSignatureSnapshots(signatureSnapshots);
  return { templateId: template.id, templateSnapshot, signatureSnapshots };
}

export async function loadSignatureBuffers(snapshots: CertificateSignatureSnapshotDto[]): Promise<{
  buffers: Map<string, Buffer>;
  missing: CertificateSignatureSnapshotDto[];
}> {
  const buffers = new Map<string, Buffer>();
  const missing: CertificateSignatureSnapshotDto[] = [];
  await Promise.all(
    snapshots.map(async (sig) => {
      if (sig.isFallback) return;
      const expectsAsset = Boolean(sig.storageKey || sig.imageUrl);
      const buf = await certificateStorage().readSignaturePng(
        sig.storageProvider,
        sig.storageKey,
        sig.imageUrl,
      );
      if (buf && buf.length > 0) {
        if (sig.signatureId) buffers.set(sig.signatureId, buf);
        if (sig.storageKey) buffers.set(sig.storageKey, buf);
      } else if (expectsAsset) {
        missing.push(sig);
      }
    }),
  );
  return { buffers, missing };
}

async function validateLinkedSourceEntities(input: {
  courseId?: string | null;
  academyQuizId?: string | null;
  examinationId?: string | null;
}): Promise<void> {
  if (input.courseId) {
    const courseExists = await prisma.course.findUnique({
      where: { id: input.courseId },
      select: { id: true },
    });
    if (!courseExists) {
      throw fieldError('VALIDATION_ERROR', 'courseId', 'Selected course was not found.');
    }
  }
  if (input.academyQuizId) {
    const quizExists = await prisma.academyQuiz.findUnique({
      where: { id: input.academyQuizId },
      select: { id: true },
    });
    if (!quizExists) {
      throw fieldError('VALIDATION_ERROR', 'academyQuizId', 'Selected Academy Quiz was not found.');
    }
  }
  if (input.examinationId) {
    const examExists = await prisma.examination.findUnique({
      where: { id: input.examinationId },
      select: { id: true },
    });
    if (!examExists) {
      throw fieldError('VALIDATION_ERROR', 'examinationId', 'Selected examination was not found.');
    }
  }
}

function deriveIdempotencyKey(input: IssueCertificateEngineInput): string | null {
  if (input.idempotencyKey) return input.idempotencyKey;
  if (input.sourceType === 'COURSE' && input.enrollmentId) {
    return `COURSE:${input.enrollmentId}`;
  }
  if (input.sourceType === 'ACADEMY_QUIZ' && input.academyQuizId && input.userId) {
    return `ACADEMY_QUIZ:${input.academyQuizId}:${input.userId}`;
  }
  if (input.sourceType === 'EXAM' && input.examinationId && input.userId) {
    return `EXAM:${input.examinationId}:${input.userId}`;
  }
  if (
    input.sourceType !== 'MANUAL' &&
    input.sourceReferenceId &&
    (input.userId || input.recipientEmail)
  ) {
    const identity = input.userId ?? input.recipientEmail!.trim().toLowerCase();
    return `${input.sourceType}:${input.sourceReferenceId}:${identity}`;
  }
  return null;
}

export async function createCertificateInsideTx(
  tx: DbClient,
  input: IssueCertificateEngineInput,
): Promise<{ certificate: CertificateWithReissues; created: boolean; deliveryIds: string[] }> {
  const idempotencyKey = deriveIdempotencyKey(input);
  if (idempotencyKey) {
    await lockIdempotencyKey(tx, idempotencyKey);
    const existing = await tx.certificate.findUnique({
      where: { idempotencyKey },
      include: {
        reissues: { select: { certificateNumber: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (existing) {
      return { certificate: existing, created: false, deliveryIds: [] };
    }
  }

  const { templateId, templateSnapshot, signatureSnapshots } = input.precomputedSnapshots
    ? input.precomputedSnapshots
    : await resolveTemplateAndSnapshots(tx, {
        templateId: input.templateId,
        certificateTitle: input.certificateTitle,
        description: input.description,
        signatures: input.signatures,
        requireExplicitSignatures: input.requireExplicitSignatures,
      });
  // Backend guarantee for every issuance path (course, quiz, manual, generic, reissue, bulk):
  // no certificate is persisted without its template's mandatory signatures.
  assertTemplateSignatureRequirement(templateSnapshot, signatureSnapshots);
  assertValidSignatureSnapshots(signatureSnapshots);
  const isArtwork = isArtworkCertificateStyle(templateSnapshot.style);

  const issuedAt = input.issuedAt ?? clock.now();
  const completedAt = input.completedAt ?? issuedAt;
  const certNumber =
    input.preallocatedCertificateNumber ??
    (await allocateCertificateNumber(tx, issuedAt.getUTCFullYear()));
  const verificationUrl = buildVerificationUrl(certNumber);
  const sourceLabel = input.sourceLabel?.trim() || SOURCE_TYPE_LABELS[input.sourceType];

  const createdCert = await tx.certificate.create({
    data: {
      certificateNumber: certNumber,
      enrollmentId: input.enrollmentId ?? null,
      userId: input.userId ?? null,
      courseId: input.courseId ?? null,
      academyQuizId: input.academyQuizId ?? null,
      examinationId: input.examinationId ?? null,
      sourceType: input.sourceType,
      sourceReferenceId:
        input.sourceReferenceId ??
        input.courseId ??
        input.academyQuizId ??
        input.examinationId ??
        null,
      sourceLabel,
      idempotencyKey,
      templateId,
      recipientName: input.recipientName,
      recipientEmail: input.recipientEmail ?? null,
      recipientStudentCode: input.recipientStudentCode ?? null,
      certificateTitle: templateSnapshot.certificateTitle,
      courseTitle: input.subjectTitle,
      description: isArtwork
        ? templateSnapshot.bodyText
        : (input.description ?? templateSnapshot.bodyText),
      // Participation artwork certificates never carry scores, marks, percentages or ranks.
      achievementDetails: isArtwork ? null : (input.achievementDetails ?? null),
      completedAt,
      issuedAt,
      status: 'ISSUED',
      metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      templateSnapshot: templateSnapshot as unknown as Prisma.InputJsonValue,
      signatureSnapshots: signatureSnapshots as unknown as Prisma.InputJsonValue,
      reissuedFromId: input.reissuedFromId ?? null,
      issuedById: input.adminActorId ?? null,
      visibleInStudentDashboard: input.visibleInStudentDashboard ?? true,
      certificateCategory: input.certificateCategory ?? null,
      quizRank: input.quizRank ?? null,
      quizAttemptId: input.quizAttemptId ?? null,
      issuedFormats: input.issuedFormats ?? ['PDF', 'PNG'],
    },
  });

  await tx.certificateVerification.create({
    data: {
      certificateId: createdCert.id,
      verificationCode: createdCert.certificateNumber,
      qrPayloadUrl: verificationUrl,
    },
  });

  await recordCertificateAudit(tx, {
    action: input.reissuedFromId ? 'certificate.reissued' : 'certificate.issued',
    actorId: input.adminActorId ?? input.userId ?? null,
    entityType: 'certificate',
    entityId: createdCert.id,
    certificateId: createdCert.id,
    data: {
      certificateNumber: createdCert.certificateNumber,
      sourceType: createdCert.sourceType,
      subjectTitle: createdCert.courseTitle,
      templateKey: templateSnapshot.key,
      signatureCount: signatureSnapshots.length,
      ...(input.reissuedFromId ? { reissuedFromId: input.reissuedFromId } : {}),
    },
  });

  if (input.adminActorId) {
    await adminAudit(tx, {
      action: input.reissuedFromId
        ? 'certificate.reissued_by_admin'
        : 'certificate.issued_by_admin',
      actorId: input.adminActorId,
      entityType: 'certificate',
      entityId: createdCert.id,
      data: {
        certificateNumber: createdCert.certificateNumber,
        sourceType: createdCert.sourceType,
        courseTitle: createdCert.courseTitle,
        ...(input.userId ? { studentId: input.userId } : {}),
      },
    });
  }

  let deliveryIds: string[] = [];
  if (input.userId && !input.skipNotification) {
    deliveryIds = await notifyUsers(tx, [input.userId], {
      type: 'CERTIFICATE',
      event: 'certificate.issued',
      title: 'Certificate Issued!',
      message:
        input.notificationMessage ??
        `Congratulations! Your certificate for "${createdCert.courseTitle}" has been issued.`,
      actionUrl: '/student/certificates',
      resource: { type: 'certificate', id: createdCert.id },
      dedupeKey: `certificate:${createdCert.id}`,
      email: !input.skipEmailNotification,
      data: {
        certificateNumber: createdCert.certificateNumber,
        courseTitle: createdCert.courseTitle,
        recipientName: createdCert.recipientName,
        sourceLabel,
      },
    });
  }

  return { certificate: createdCert, created: true, deliveryIds };
}

export const certificatesService = {
  /**
   * Generic, centralized certificate issuance engine callable by any ASRA Academy module
   * (Courses, Academy Quizzes, Competitions, Examinations, Events, Workshops, Training, Manual, Custom).
   * Enforces idempotency when an idempotencyKey or source+user pair is present.
   */
  async issueGenericCertificate(input: IssueCertificateEngineInput): Promise<CertificateDto> {
    const result = await prisma.$transaction(async (tx) => {
      if (
        input.sourceType === 'ACADEMY_QUIZ' &&
        input.academyQuizId &&
        input.userId &&
        !input.adminActorId
      ) {
        const quiz = await tx.academyQuiz.findUnique({ where: { id: input.academyQuizId } });
        if (!quiz) throw new AppError('NOT_FOUND', 'Academy quiz not found');
        if (!resultsReleased(quiz, clock.now())) {
          throw new AppError('BAD_REQUEST', 'Quiz results have not been released yet.');
        }
        const passedAttempt = await tx.assessmentAttempt.findFirst({
          where: {
            academyQuizId: quiz.id,
            userId: input.userId,
            status: { in: ['SUBMITTED', 'EXPIRED'] },
            evaluationStatus: 'EVALUATED',
            ...(quiz.passPercent > 0 ? { passed: true } : {}),
          },
          orderBy: { score: 'desc' },
        });
        if (!passedAttempt) {
          throw new AppError('BAD_REQUEST', 'You have not met the passing criteria for this quiz.');
        }
      }

      if (
        input.sourceType === 'EXAM' &&
        input.examinationId &&
        input.userId &&
        !input.adminActorId
      ) {
        const exam = await tx.examination.findUnique({ where: { id: input.examinationId } });
        if (!exam) throw new AppError('NOT_FOUND', 'Examination not found');
        const passedAttempt = await tx.assessmentAttempt.findFirst({
          where: {
            examinationId: exam.id,
            userId: input.userId,
            status: { in: ['SUBMITTED', 'EXPIRED'] },
            evaluationStatus: 'EVALUATED',
            passed: true,
          },
        });
        if (!passedAttempt) {
          throw new AppError(
            'BAD_REQUEST',
            'You must pass this examination to receive a certificate.',
          );
        }
      }

      return createCertificateInsideTx(tx, input);
    });

    if (result.created) {
      dispatchAfterCommit(result.deliveryIds);
    }

    return toCertificateDto(
      result.certificate,
      await hydrateSignatureSnapshots(result.certificate.signatureSnapshots),
    );
  },

  /**
   * Evaluates eligibility for a Course certificate.
   * Pure inspection: does not create records or alter state.
   */
  async checkEligibility(
    auth: AuthContext,
    courseId: string,
    db: DbClient = prisma,
  ): Promise<CertificateEligibilityResult> {
    const [course, enrollment] = await Promise.all([
      db.course.findUnique({
        where: { id: courseId },
        select: { id: true, title: true, status: true },
      }),
      db.enrollment.findUnique({
        where: { userId_courseId: { userId: auth.userId, courseId } },
        include: {
          certificate: {
            include: {
              reissues: {
                select: { certificateNumber: true },
                orderBy: { createdAt: 'desc' },
                take: 1,
              },
            },
          },
        },
      }),
    ]);

    if (!course) {
      throw new AppError('NOT_FOUND', 'Course not found');
    }

    const reasons: CertificateIneligibilityReason[] = [];

    if (!enrollment) {
      return {
        state: 'INELIGIBLE',
        eligible: false,
        courseId: course.id,
        courseTitle: course.title,
        enrollmentId: null,
        completedAt: null,
        certificate: null,
        reasons: [
          {
            code: 'NOT_ENROLLED',
            message: 'You are not enrolled in this course.',
          },
        ],
        progress: null,
      };
    }

    if (enrollment.certificate) {
      return {
        state: 'ALREADY_ISSUED',
        eligible: true,
        courseId: course.id,
        courseTitle: course.title,
        enrollmentId: enrollment.id,
        completedAt: enrollment.completedAt?.toISOString() ?? null,
        certificate: toCertificateDto(enrollment.certificate),
        reasons: [],
        progress: null,
      };
    }

    if (enrollment.status !== 'ACTIVE') {
      reasons.push({
        code: 'ENROLLMENT_INACTIVE',
        message: 'Your enrollment in this course is not active.',
      });
    }

    const studentRepo = createStudentRepository(db);
    const structures = await studentRepo.structures([courseId]);
    const structure = structures.get(courseId);
    const view = toCourseView(structure);
    const progressRows = await studentRepo.progress.forLessons(
      auth.userId,
      view.lessons.map((l) => l.id),
    );
    const completedLessonIds = new Set<string>(
      progressRows.filter((r) => r.completedAt !== null).map((r) => r.lessonId),
    );
    const progress = calculateCourseProgress(
      view.eligibleIds,
      completedLessonIds,
      enrollment.completedAt,
    );

    const isComplete = enrollment.completedAt !== null || isCourseComplete(progress);
    if (!isComplete) {
      reasons.push({
        code: 'PROGRESS_INCOMPLETE',
        message: `Course progress is incomplete (${progress.completedLessons} of ${progress.totalLessons} lessons completed).`,
      });
    }

    const publishedExams = await db.examination.findMany({
      where: { courseId, status: 'PUBLISHED' },
      select: { id: true, title: true, passPercent: true },
    });

    if (publishedExams.length > 0) {
      for (const exam of publishedExams) {
        const attempts = await db.assessmentAttempt.findMany({
          where: { examinationId: exam.id, userId: auth.userId },
          select: { status: true, evaluationStatus: true, passed: true },
        });

        const pendingAttempt = attempts.find(
          (a) => a.status === 'SUBMITTED' && a.evaluationStatus === 'PENDING',
        );

        if (pendingAttempt) {
          reasons.push({
            code: 'EXAM_PENDING_GRADING',
            message: `Your examination "${exam.title}" is currently pending evaluation.`,
          });
        } else {
          const hasPassed = attempts.some((a) => a.passed === true);
          if (!hasPassed) {
            reasons.push({
              code: 'EXAM_NOT_PASSED',
              message: `You must pass the examination "${exam.title}" (Passing score: ${exam.passPercent}%).`,
            });
          }
        }
      }
    }

    const eligible = reasons.length === 0;

    return {
      state: eligible ? 'ELIGIBLE' : 'INELIGIBLE',
      eligible,
      courseId: course.id,
      courseTitle: course.title,
      enrollmentId: enrollment.id,
      completedAt: enrollment.completedAt?.toISOString() ?? null,
      certificate: null,
      reasons,
      progress,
    };
  },

  /**
   * Idempotently issues a certificate for a qualifying course enrollment.
   * Preserves Phase 13 row locking and concurrency behavior while using the generic engine.
   */
  async issueCertificate(
    auth: AuthContext,
    courseId: string,
    adminActorId?: string,
  ): Promise<CertificateDto> {
    const txResult = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "enrollments" WHERE "user_id" = ${auth.userId}::uuid AND "course_id" = ${courseId}::uuid FOR UPDATE`;

      const eligibility = await certificatesService.checkEligibility(auth, courseId, tx);

      if (eligibility.state === 'ALREADY_ISSUED' && eligibility.certificate) {
        return {
          certificate: null as CertificateWithReissues | null,
          existingDto: eligibility.certificate,
          deliveryIds: [] as string[],
        };
      }

      if (!eligibility.eligible || !eligibility.enrollmentId) {
        const firstReason = eligibility.reasons[0]?.message ?? 'Not eligible for certificate';
        throw new AppError('BAD_REQUEST', firstReason);
      }

      const [student, enrollment] = await Promise.all([
        tx.user.findUniqueOrThrow({
          where: { id: auth.userId },
          select: {
            id: true,
            fullName: true,
            email: true,
            studentProfile: { select: { studentCode: true } },
          },
        }),
        tx.enrollment.findUniqueOrThrow({
          where: { id: eligibility.enrollmentId },
          include: { course: true },
        }),
      ]);

      const now = new Date();
      let completedAt = enrollment.completedAt;
      if (!completedAt) {
        completedAt = now;
        await tx.enrollment.update({
          where: { id: enrollment.id },
          data: { completedAt: now },
        });
      }

      const { certificate, created, deliveryIds } = await createCertificateInsideTx(tx, {
        sourceType: 'COURSE',
        sourceReferenceId: enrollment.courseId,
        sourceLabel: 'Course',
        userId: auth.userId,
        enrollmentId: enrollment.id,
        courseId: enrollment.courseId,
        recipientName: student.fullName,
        recipientEmail: student.email,
        recipientStudentCode: student.studentProfile?.studentCode ?? null,
        subjectTitle: enrollment.course.title,
        completedAt,
        issuedAt: now,
        idempotencyKey: `COURSE:${enrollment.id}`,
        adminActorId: adminActorId ?? null,
      });

      return {
        certificate,
        existingDto: null as CertificateDto | null,
        deliveryIds: created ? deliveryIds : [],
      };
    });

    if (txResult.existingDto) {
      return txResult.existingDto;
    }

    if (txResult.deliveryIds.length > 0) {
      dispatchAfterCommit(txResult.deliveryIds);
    }

    const issued = txResult.certificate!;
    return toCertificateDto(issued, await hydrateSignatureSnapshots(issued.signatureSnapshots));
  },

  /**
   * Evaluates and idempotently issues an Academy Quiz certificate via the generic engine
   * when the student has a finalized, released, passing attempt.
   */
  async issueAcademyQuizCertificate(
    auth: AuthContext,
    academyQuizId: string,
  ): Promise<CertificateDto> {
    const [quiz, student] = await Promise.all([
      prisma.academyQuiz.findUnique({ where: { id: academyQuizId } }),
      prisma.user.findUniqueOrThrow({
        where: { id: auth.userId },
        select: {
          id: true,
          fullName: true,
          email: true,
          studentProfile: { select: { studentCode: true } },
        },
      }),
    ]);

    if (!quiz) {
      throw new AppError('NOT_FOUND', 'Academy quiz not found');
    }

    const bestPassed = await prisma.assessmentAttempt.findFirst({
      where: {
        academyQuizId,
        userId: auth.userId,
        status: { in: ['SUBMITTED', 'EXPIRED'] },
        evaluationStatus: 'EVALUATED',
        ...(quiz.passPercent > 0 ? { passed: true } : {}),
      },
      orderBy: [{ score: 'desc' }, { submittedAt: 'asc' }],
    });

    if (!bestPassed) {
      throw new AppError(
        'BAD_REQUEST',
        'Complete and pass this Academy Quiz to earn a certificate.',
      );
    }

    const existingParticipation = await prisma.certificate.findFirst({
      where: {
        academyQuizId: quiz.id,
        userId: auth.userId,
        status: 'ISSUED',
        OR: [{ certificateCategory: 'PARTICIPATION' }, { certificateCategory: null }],
      },
      include: {
        reissues: { select: { certificateNumber: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (existingParticipation) {
      return toCertificateDto(
        existingParticipation,
        await hydrateSignatureSnapshots(existingParticipation.signatureSnapshots),
      );
    }

    const pct = bestPassed.percent !== null ? Number(bestPassed.percent) : null;
    return certificatesService.issueGenericCertificate({
      sourceType: 'ACADEMY_QUIZ',
      sourceReferenceId: quiz.id,
      sourceLabel: 'Academy Quiz',
      userId: auth.userId,
      academyQuizId: quiz.id,
      recipientName: student.fullName,
      recipientEmail: student.email,
      recipientStudentCode: student.studentProfile?.studentCode ?? null,
      certificateTitle: 'CERTIFICATE OF ACHIEVEMENT',
      subjectTitle: quiz.title,
      description: 'has successfully completed and achieved distinction in the Academy Quiz',
      achievementDetails: pct !== null ? `Score Achieved: ${pct}%` : null,
      completedAt: bestPassed.submittedAt ?? clock.now(),
      idempotencyKey: `ACADEMY_QUIZ:${quiz.id}:${auth.userId}`,
      certificateCategory: 'PARTICIPATION',
      quizAttemptId: bestPassed.id,
    });
  },

  /**
   * Admin: Issue a single certificate manually (Option A existing student or Option B manual recipient)
   * OR via any custom/module source.
   */
  async issueManualCertificate(
    auth: AuthContext,
    input: ManualCertificateIssueInput,
  ): Promise<CertificateDto> {
    let userId: string | null = null;
    let recipientName = input.recipientName;
    let recipientEmail = input.recipientEmail ?? null;
    let recipientStudentCode = input.recipientStudentCode ?? null;

    if (input.recipientMode === 'EXISTING_STUDENT') {
      const student = await prisma.user.findUnique({
        where: { id: input.userId! },
        select: {
          id: true,
          fullName: true,
          email: true,
          studentProfile: { select: { studentCode: true } },
        },
      });
      if (!student) {
        throw fieldError('VALIDATION_ERROR', 'userId', 'Selected student account was not found.');
      }
      userId = student.id;
      recipientName = input.recipientName || student.fullName;
      recipientEmail = input.recipientEmail ?? student.email;
      recipientStudentCode =
        input.recipientStudentCode ?? student.studentProfile?.studentCode ?? null;
    }

    await validateLinkedSourceEntities(input);

    const issuedAt = input.issuedAt ? new Date(input.issuedAt) : clock.now();
    const completedAt = input.completedAt ? new Date(input.completedAt) : issuedAt;

    const txResult = await prisma.$transaction((tx) =>
      createCertificateInsideTx(tx, {
        sourceType: input.sourceType,
        sourceReferenceId: input.sourceReferenceId ?? null,
        sourceLabel: input.sourceLabel ?? SOURCE_TYPE_LABELS[input.sourceType],
        userId,
        courseId: input.courseId ?? null,
        academyQuizId: input.academyQuizId ?? null,
        examinationId: input.examinationId ?? null,
        recipientName,
        recipientEmail,
        recipientStudentCode,
        templateId: input.templateId,
        certificateTitle: input.certificateTitle,
        subjectTitle: input.subjectTitle,
        description: input.description ?? null,
        achievementDetails: input.achievementDetails ?? null,
        completedAt,
        issuedAt,
        signatures: input.signatures,
        requireExplicitSignatures: true,
        metadata: {
          ...(input.metadata ?? {}),
          manualRecipientMode: input.recipientMode,
        },
        adminActorId: auth.userId,
      }),
    );

    if (txResult.created) {
      dispatchAfterCommit(txResult.deliveryIds);
    }
    return toCertificateDto(
      txResult.certificate,
      await hydrateSignatureSnapshots(txResult.certificate.signatureSnapshots),
    );
  },

  /**
   * Admin: Generic issuance API for module-triggered or custom source bulk/single issuance.
   */
  async issueAdminGenericCertificate(
    auth: AuthContext,
    input: GenericCertificateIssueInput,
  ): Promise<CertificateDto> {
    if (input.userId) {
      const user = await prisma.user.findUnique({
        where: { id: input.userId },
        select: { id: true },
      });
      if (!user) throw fieldError('VALIDATION_ERROR', 'userId', 'Target user was not found.');
    }
    await validateLinkedSourceEntities(input);

    const issuedAt = input.issuedAt ? new Date(input.issuedAt) : clock.now();
    const completedAt = input.completedAt ? new Date(input.completedAt) : issuedAt;

    return certificatesService.issueGenericCertificate({
      sourceType: input.sourceType,
      sourceReferenceId: input.sourceReferenceId ?? null,
      sourceLabel: input.sourceLabel ?? SOURCE_TYPE_LABELS[input.sourceType],
      userId: input.userId ?? null,
      enrollmentId: input.enrollmentId ?? null,
      courseId: input.courseId ?? null,
      academyQuizId: input.academyQuizId ?? null,
      examinationId: input.examinationId ?? null,
      recipientName: input.recipientName,
      recipientEmail: input.recipientEmail ?? null,
      recipientStudentCode: input.recipientStudentCode ?? null,
      templateId: input.templateId ?? null,
      certificateTitle: input.certificateTitle ?? null,
      subjectTitle: input.subjectTitle,
      description: input.description ?? null,
      achievementDetails: input.achievementDetails ?? null,
      completedAt,
      issuedAt,
      idempotencyKey: input.idempotencyKey ?? null,
      signatures: input.signatures,
      requireExplicitSignatures: true,
      metadata: input.metadata ?? null,
      adminActorId: auth.userId,
    });
  },

  /**
   * Admin: Reissue an existing certificate (e.g., name correction or updated layout/signatures).
   * Locks the original record `FOR UPDATE`, preserves deterministic idempotency keys onto the
   * replacement, and supersedes the prior credential safely without writing generated file metadata.
   */
  async reissueCertificate(
    auth: AuthContext,
    id: string,
    input: ReissueCertificateInput,
  ): Promise<CertificateDto> {
    const txResult = await prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "certificates" WHERE "id" = ${id}::uuid FOR UPDATE
      `;
      if (!locked) {
        throw new AppError('NOT_FOUND', 'Original certificate not found');
      }

      const original = await tx.certificate.findUniqueOrThrow({ where: { id } });

      // Idempotent concurrency protection: if an active replacement already exists for this source row, return it.
      const existingReissue = await tx.certificate.findFirst({
        where: { reissuedFromId: original.id, status: 'ISSUED' },
        orderBy: { createdAt: 'desc' },
        include: {
          reissues: {
            select: { certificateNumber: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      });
      if (existingReissue) {
        return {
          certificate: existingReissue,
          created: false,
          deliveryIds: [] as string[],
        };
      }

      const preservedEnrollmentId = original.enrollmentId;

      let inheritedIdempotencyKey: string | null = null;
      if (
        original.idempotencyKey &&
        !original.idempotencyKey.startsWith('SUPERSEDED:') &&
        !original.idempotencyKey.startsWith('REISSUE:')
      ) {
        inheritedIdempotencyKey = original.idempotencyKey;
      } else {
        inheritedIdempotencyKey = deriveIdempotencyKey({
          sourceType: original.sourceType,
          sourceReferenceId: original.sourceReferenceId,
          userId: original.userId,
          enrollmentId: preservedEnrollmentId,
          courseId: original.courseId,
          academyQuizId: original.academyQuizId,
          examinationId: original.examinationId,
          recipientName: original.recipientName,
          recipientEmail: original.recipientEmail,
          subjectTitle: original.courseTitle,
        });
      }

      const supersedesActive = original.status === 'ISSUED';
      if (supersedesActive || original.enrollmentId || original.idempotencyKey) {
        await tx.certificate.update({
          where: { id: original.id },
          data: {
            ...(supersedesActive
              ? {
                  status: 'REVOKED',
                  revokedAt: clock.now(),
                  revokedReason: `Superseded by reissue: ${input.reason}`,
                  revokedById: auth.userId,
                }
              : {}),
            enrollmentId: null,
            idempotencyKey: `SUPERSEDED:${original.id}:${crypto.randomUUID().slice(0, 8)}`,
          },
        });
      }

      if (supersedesActive) {
        await recordCertificateAudit(tx, {
          action: 'certificate.superseded',
          actorId: auth.userId,
          entityType: 'certificate',
          entityId: original.id,
          certificateId: original.id,
          data: {
            certificateNumber: original.certificateNumber,
            reason: input.reason,
          },
        });
      }

      const prevSnapshots = Array.isArray(original.signatureSnapshots)
        ? (original.signatureSnapshots as unknown as CertificateSignatureSnapshotDto[])
        : [];
      const realPrevSnapshots = prevSnapshots.filter(
        (s): s is CertificateSignatureSnapshotDto & { signatureId: string } =>
          !s.isFallback && Boolean(s.signatureId),
      );
      const fallbackPlacements: CertificateSignaturePlacementInput[] | undefined =
        input.signatures ??
        (realPrevSnapshots.length > 0
          ? realPrevSnapshots.map((s) => ({
              signatureId: s.signatureId,
              sortOrder: s.sortOrder,
              positionLabel: s.positionLabel,
              showName: s.showName,
              showDesignation: s.showDesignation,
            }))
          : undefined);

      // Certificates issued on an archived (retired) template are reissued on the current default
      // template unless the administrator explicitly selects one.
      const originalTemplate = original.templateId
        ? await tx.certificateTemplate.findUnique({
            where: { id: original.templateId },
            select: { id: true, isActive: true, key: true },
          })
        : null;
      const reusableOriginalTemplateId =
        originalTemplate?.isActive && !isRetiredTemplateKey(originalTemplate.key)
          ? originalTemplate.id
          : null;

      const issued = await createCertificateInsideTx(tx, {
        sourceType: original.sourceType,
        sourceReferenceId: original.sourceReferenceId,
        sourceLabel: original.sourceLabel,
        userId: original.userId,
        enrollmentId: preservedEnrollmentId,
        courseId: original.courseId,
        academyQuizId: original.academyQuizId,
        examinationId: original.examinationId,
        recipientName: original.recipientName,
        recipientEmail: original.recipientEmail,
        recipientStudentCode: original.recipientStudentCode,
        templateId: input.templateId ?? reusableOriginalTemplateId,
        certificateTitle: input.certificateTitle ?? original.certificateTitle,
        subjectTitle: input.subjectTitle ?? original.courseTitle,
        description: input.description ?? original.description,
        achievementDetails: input.achievementDetails ?? original.achievementDetails,
        completedAt: original.completedAt,
        issuedAt: clock.now(),
        idempotencyKey: inheritedIdempotencyKey,
        signatures: fallbackPlacements,
        requireExplicitSignatures: input.signatures !== undefined || realPrevSnapshots.length > 0,
        reissuedFromId: original.id,
        metadata: {
          ...((original.metadata as Record<string, unknown> | null) ?? {}),
          reissueReason: input.reason,
        },
        adminActorId: auth.userId,
      });

      return issued;
    });

    if (txResult.created) {
      dispatchAfterCommit(txResult.deliveryIds);
    }

    return toCertificateDto(
      txResult.certificate,
      await hydrateSignatureSnapshots(txResult.certificate.signatureSnapshots),
    );
  },

  /**
   * Student: List earned certificates with optional sourceType filter and search.
   */
  async getStudentCertificates(
    auth: AuthContext,
    query: StudentCertificateQuery,
  ): Promise<Paginated<CertificateDto>> {
    const { skip, take } = pageArgs(query);
    const where: Prisma.CertificateWhereInput = {
      userId: auth.userId,
      visibleInStudentDashboard: true,
      ...(query.sourceType ? { sourceType: query.sourceType } : {}),
      ...(query.search
        ? {
            OR: [
              { certificateNumber: { contains: query.search, mode: 'insensitive' } },
              { courseTitle: { contains: query.search, mode: 'insensitive' } },
              { certificateTitle: { contains: query.search, mode: 'insensitive' } },
              { sourceLabel: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.certificate.findMany({
        where,
        skip,
        take,
        orderBy: { issuedAt: 'desc' },
        include: {
          reissues: {
            select: { certificateNumber: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      }),
      prisma.certificate.count({ where }),
    ]);

    const items = await Promise.all(
      rows.map(async (row) =>
        toCertificateDto(row, await hydrateSignatureSnapshots(row.signatureSnapshots)),
      ),
    );
    return paginated(items, total, query);
  },

  async getStudentCertificateById(auth: AuthContext, id: string): Promise<CertificateDto> {
    const cert = await prisma.certificate.findFirst({
      where: { id, userId: auth.userId, visibleInStudentDashboard: true },
      include: {
        reissues: { select: { certificateNumber: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (!cert) {
      throw new AppError('NOT_FOUND', 'Certificate not found');
    }
    return toCertificateDto(cert, await hydrateSignatureSnapshots(cert.signatureSnapshots));
  },

  /**
   * Public verification endpoint.
   * Privacy-safe: never exposes student email, internal IDs, student codes, or scores.
   * Never treats REVOKED or SUPERSEDED certificates as valid.
   */
  async verifyPublicCertificate(
    certificateNumber: string,
  ): Promise<PublicCertificateVerificationDto> {
    const cert = await prisma.certificate.findUnique({
      where: { certificateNumber },
      include: {
        verification: true,
        reissues: { select: { certificateNumber: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    if (!cert) {
      throw new AppError('NOT_FOUND', 'Certificate not found with this identifier');
    }

    let verifiedCount = cert.verification?.verifiedCount ?? 0;
    try {
      const now = clock.now();
      const updated = await prisma.certificateVerification.upsert({
        where: { certificateId: cert.id },
        update: { verifiedCount: { increment: 1 }, lastVerifiedAt: now },
        create: {
          certificateId: cert.id,
          verificationCode: cert.certificateNumber,
          qrPayloadUrl: buildVerificationUrl(cert.certificateNumber),
          verifiedCount: 1,
          lastVerifiedAt: now,
        },
        select: { verifiedCount: true },
      });
      verifiedCount = updated.verifiedCount;
    } catch {
      // Telemetry increment must never break public verification
    }

    const { lifecycleStatus, supersededByCertificateNumber } =
      resolveCertificateLifecycleStatus(cert);
    const templateSnapshot = parseTemplateSnapshot(cert.templateSnapshot, {
      certificateTitle: cert.certificateTitle,
      description: cert.description,
    });
    const sigs = resolveCertificateSignatureSnapshots(cert.signatureSnapshots);

    return {
      valid: lifecycleStatus === 'ISSUED',
      certificateNumber: cert.certificateNumber,
      status: cert.status,
      lifecycleStatus,
      supersededByCertificateNumber,
      sourceType: cert.sourceType,
      sourceLabel: cert.sourceLabel ?? SOURCE_TYPE_LABELS[cert.sourceType],
      certificateTitle: cert.certificateTitle,
      recipientName: cert.recipientName,
      courseTitle: cert.courseTitle,
      description: cert.description,
      achievementDetails: isArtworkCertificateStyle(templateSnapshot.style)
        ? null
        : cert.achievementDetails,
      academyName: templateSnapshot.issuingAuthority || 'ASRA Academy',
      completedAt: cert.completedAt.toISOString(),
      issuedAt: cert.issuedAt.toISOString(),
      revokedAt: cert.revokedAt ? cert.revokedAt.toISOString() : null,
      revokedReason: cert.revokedReason,
      signatories: sigs
        .filter((s) => s.showName || s.showDesignation)
        .map((s) => ({
          fullName: s.showName ? s.fullName : 'Authorized Signatory',
          designation: s.showDesignation ? s.designation : 'ASRA Academy',
          department: s.department ?? null,
        })),
      verifiedCount,
    };
  },

  /**
   * Dynamically renders a certificate in memory as PDF or PNG from PostgreSQL records
   * and original Cloudinary signature PNG assets without reading or writing stored certificate files.
   */
  async getCertificateDocument(
    certificateId: string,
    format: 'pdf' | 'png',
    auth?: AuthContext,
  ): Promise<{
    buffer: Buffer;
    filename: string;
    mimeType: 'application/pdf' | 'image/png';
    certificate: CertificateDto;
  }> {
    const cert = await prisma.certificate.findUnique({
      where: { id: certificateId },
      include: {
        reissues: { select: { certificateNumber: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    if (!cert) {
      throw new AppError('NOT_FOUND', 'Certificate not found');
    }

    if (auth) {
      const isOwner = cert.userId !== null && cert.userId === auth.userId;
      const canAdminViewPdf =
        auth.permissions.has(PERMISSIONS.CERTIFICATES_VIEW) ||
        auth.permissions.has(PERMISSIONS.CERTIFICATES_MANAGE) ||
        auth.permissions.has(PERMISSIONS.CERTIFICATES_TEMPLATES_MANAGE) ||
        auth.permissions.has(PERMISSIONS.CERTIFICATES_SIGNATURES_MANAGE) ||
        auth.permissions.has(PERMISSIONS.CERTIFICATES_ISSUE) ||
        auth.permissions.has(PERMISSIONS.CERTIFICATES_REVOKE);
      if (!isOwner && !canAdminViewPdf) {
        throw new AppError('FORBIDDEN', 'You do not have permission to download this certificate');
      }
      if (!canAdminViewPdf && cert.visibleInStudentDashboard === false) {
        throw new AppError(
          'FORBIDDEN',
          'This certificate is not available in your student dashboard',
        );
      }
      if (
        !canAdminViewPdf &&
        Array.isArray(cert.issuedFormats) &&
        cert.issuedFormats.length > 0 &&
        !cert.issuedFormats.includes(format.toUpperCase())
      ) {
        throw new AppError(
          'BAD_REQUEST',
          `${format.toUpperCase()} format is not enabled for this certificate.`,
        );
      }
    }

    const templateSnapshot = parseTemplateSnapshot(cert.templateSnapshot, {
      certificateTitle: cert.certificateTitle,
      description: cert.description,
    });
    const signatureSnapshots = resolveCertificateSignatureSnapshots(cert.signatureSnapshots);
    const { buffers: signatureBuffers, missing } = await loadSignatureBuffers(signatureSnapshots);

    if (missing.length > 0) {
      logger.warn(
        {
          certificateId: cert.id,
          certificateNumber: cert.certificateNumber,
          format,
          missingCount: missing.length,
          missingKeys: missing.map((m) => m.storageKey ?? m.signatureId),
        },
        'Certificate generation aborted because signature image(s) failed to load',
      );
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'Digital signature image is temporarily unavailable. Please try downloading again in a moment.',
      );
    }

    const { lifecycleStatus, supersededByCertificateNumber } =
      resolveCertificateLifecycleStatus(cert);
    const verificationUrl = buildVerificationUrl(cert.certificateNumber);
    const renderInput = {
      certificateNumber: cert.certificateNumber,
      recipientName: cert.recipientName,
      certificateTitle: cert.certificateTitle,
      courseTitle: cert.courseTitle,
      description: cert.description,
      achievementDetails: cert.achievementDetails,
      sourceType: cert.sourceType,
      sourceLabel: cert.sourceLabel,
      completedAt: cert.completedAt,
      issuedAt: cert.issuedAt,
      status: cert.status,
      lifecycleStatus,
      supersededByCertificateNumber,
      verificationUrl,
      templateSnapshot,
      signatureSnapshots,
      signatureBuffers,
    };

    try {
      const buffer = format === 'png' ? await renderPng(renderInput) : await renderPdf(renderInput);
      const mimeType = format === 'png' ? 'image/png' : 'application/pdf';
      const filename = `ASRA-Certificate-${cert.certificateNumber}.${format}`;
      return {
        buffer,
        filename,
        mimeType,
        certificate: toCertificateDto(cert),
      };
    } finally {
      signatureBuffers.clear();
    }
  },

  async getCertificatePdf(
    certificateId: string,
    auth?: AuthContext,
  ): Promise<{ buffer: Buffer; filename: string; certificate: CertificateDto }> {
    const doc = await certificatesService.getCertificateDocument(certificateId, 'pdf', auth);
    return { buffer: doc.buffer, filename: doc.filename, certificate: doc.certificate };
  },

  async getCertificatePng(
    certificateId: string,
    auth?: AuthContext,
  ): Promise<{ buffer: Buffer; filename: string; certificate: CertificateDto }> {
    const doc = await certificatesService.getCertificateDocument(certificateId, 'png', auth);
    return { buffer: doc.buffer, filename: doc.filename, certificate: doc.certificate };
  },

  /**
   * Admin: Overview KPIs & breakdown for `/admin/certificates`.
   */
  async getOverviewStats(): Promise<CertificateOverviewStatsDto> {
    await ensureCertificateDefaults(prisma);
    const now = clock.now();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));

    const [
      totalIssued,
      totalRevoked,
      issuedThisMonth,
      activeTemplates,
      totalSignatures,
      activeSignatures,
      groupedBySource,
      recentRows,
    ] = await Promise.all([
      prisma.certificate.count({ where: { status: 'ISSUED' } }),
      prisma.certificate.count({ where: { status: 'REVOKED' } }),
      prisma.certificate.count({ where: { issuedAt: { gte: monthStart } } }),
      prisma.certificateTemplate.count({ where: { isActive: true } }),
      prisma.certificateSignature.count(),
      prisma.certificateSignature.count({ where: { isActive: true } }),
      prisma.certificate.groupBy({
        by: ['sourceType'],
        _count: { _all: true },
      }),
      prisma.certificate.findMany({
        take: 8,
        orderBy: { issuedAt: 'desc' },
        include: {
          user: { select: { email: true } },
          issuedBy: { select: { fullName: true } },
          template: { select: { name: true } },
          reissues: {
            select: { certificateNumber: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      }),
    ]);

    const bySource = groupedBySource.map((g) => ({
      sourceType: g.sourceType,
      count: g._count._all,
    }));
    const countFor = (t: CertificateSourceType) =>
      bySource.find((b) => b.sourceType === t)?.count ?? 0;

    return {
      totalIssued,
      totalRevoked,
      issuedThisMonth,
      activeTemplates,
      totalSignatures,
      activeSignatures,
      bySource,
      coursesCount: countFor('COURSE'),
      academyQuizzesCount: countFor('ACADEMY_QUIZ'),
      competitionsCount: countFor('COMPETITION'),
      recentCertificates: recentRows.map((row) => toAdminCertificateListItem(row)),
    };
  },

  /**
   * Admin: List certificates with filtering by status, sourceType, course, quiz, student, or search.
   */
  async listAdminCertificates(
    query: AdminCertificateQuery,
  ): Promise<Paginated<AdminCertificateListItem>> {
    const { skip, take } = pageArgs(query);

    const where: Prisma.CertificateWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.sourceType) where.sourceType = query.sourceType;
    if (query.courseId) where.courseId = query.courseId;
    if (query.academyQuizId) where.academyQuizId = query.academyQuizId;
    if (query.studentId) where.userId = query.studentId;

    if (query.search) {
      where.OR = [
        { certificateNumber: { contains: query.search, mode: 'insensitive' } },
        { recipientName: { contains: query.search, mode: 'insensitive' } },
        { recipientEmail: { contains: query.search, mode: 'insensitive' } },
        { recipientStudentCode: { contains: query.search, mode: 'insensitive' } },
        { courseTitle: { contains: query.search, mode: 'insensitive' } },
        { certificateTitle: { contains: query.search, mode: 'insensitive' } },
        { user: { email: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.certificate.findMany({
        where,
        skip,
        take,
        orderBy: { issuedAt: 'desc' },
        include: {
          user: { select: { email: true } },
          issuedBy: { select: { fullName: true } },
          template: { select: { name: true } },
          reissues: {
            select: { certificateNumber: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      }),
      prisma.certificate.count({ where }),
    ]);

    return paginated(
      rows.map((row) => toAdminCertificateListItem(row)),
      total,
      query,
    );
  },

  async getAdminCertificateById(id: string): Promise<AdminCertificateListItem> {
    const cert = await prisma.certificate.findUnique({
      where: { id },
      include: {
        user: { select: { email: true } },
        issuedBy: { select: { fullName: true } },
        template: { select: { name: true } },
        reissues: { select: { certificateNumber: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (!cert) {
      throw new AppError('NOT_FOUND', 'Certificate not found');
    }
    const hydrated = await hydrateSignatureSnapshots(cert.signatureSnapshots);
    return toAdminCertificateListItem(cert, hydrated);
  },

  async revokeCertificate(auth: AuthContext, id: string, reason: string): Promise<CertificateDto> {
    const updated = await prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "certificates" WHERE "id" = ${id}::uuid FOR UPDATE
      `;
      if (!locked) {
        throw new AppError('NOT_FOUND', 'Certificate not found');
      }

      const cert = await tx.certificate.findUniqueOrThrow({ where: { id } });
      if (cert.status === 'REVOKED') {
        throw new AppError('BAD_REQUEST', 'Certificate is already revoked');
      }

      const now = clock.now();
      const row = await tx.certificate.update({
        where: { id },
        data: {
          status: 'REVOKED',
          revokedAt: now,
          revokedReason: reason,
          revokedById: auth.userId,
        },
        include: {
          reissues: {
            select: { certificateNumber: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      });

      await recordCertificateAudit(tx, {
        action: 'certificate.revoked',
        actorId: auth.userId,
        entityType: 'certificate',
        entityId: id,
        certificateId: id,
        data: {
          certificateNumber: cert.certificateNumber,
          reason,
        },
      });

      await adminAudit(tx, {
        action: 'certificate.revoked_by_admin',
        actorId: auth.userId,
        entityType: 'certificate',
        entityId: id,
        data: {
          certificateNumber: cert.certificateNumber,
          reason,
        },
      });

      return row;
    });

    return toCertificateDto(updated, await hydrateSignatureSnapshots(updated.signatureSnapshots));
  },

  async getSettings(): Promise<CertificateSettingsDto> {
    await ensureCertificateDefaults(prisma);
    const settings = await prisma.certificateSettings.findUniqueOrThrow({
      where: { id: 'default' },
    });
    return toSettingsDto(settings);
  },

  async updateSettings(
    auth: AuthContext,
    input: UpdateCertificateSettingsInput,
  ): Promise<CertificateSettingsDto> {
    await ensureCertificateDefaults(prisma);
    const updated = await prisma.$transaction(async (tx) => {
      if (input.defaultTemplateId) {
        const tpl = await tx.certificateTemplate.findUnique({
          where: { id: input.defaultTemplateId },
          select: { id: true, isActive: true },
        });
        if (!tpl || !tpl.isActive) {
          throw fieldError(
            'VALIDATION_ERROR',
            'defaultTemplateId',
            'Default template must be an active certificate template.',
          );
        }
        await tx.certificateTemplate.updateMany({
          where: { isDefault: true, id: { not: tpl.id } },
          data: { isDefault: false },
        });
        await tx.certificateTemplate.update({
          where: { id: tpl.id },
          data: { isDefault: true },
        });
      }

      const row = await tx.certificateSettings.update({
        where: { id: 'default' },
        data: {
          ...(input.academyName !== undefined ? { academyName: input.academyName } : {}),
          ...(input.academyTagline !== undefined ? { academyTagline: input.academyTagline } : {}),
          ...(input.defaultTemplateId !== undefined
            ? { defaultTemplateId: input.defaultTemplateId }
            : {}),
          ...(input.verificationNotice !== undefined
            ? { verificationNotice: input.verificationNotice }
            : {}),
          ...(input.showQrOnCertificates !== undefined
            ? { showQrOnCertificates: input.showQrOnCertificates }
            : {}),
          ...(input.autoIssueOnCourseCompletion !== undefined
            ? { autoIssueOnCourseCompletion: input.autoIssueOnCourseCompletion }
            : {}),
          ...(input.autoIssueOnQuizCompletion !== undefined
            ? { autoIssueOnQuizCompletion: input.autoIssueOnQuizCompletion }
            : {}),
          updatedById: auth.userId,
        },
      });

      await recordCertificateAudit(tx, {
        action: 'settings.updated',
        actorId: auth.userId,
        entityType: 'settings',
        entityId: 'default',
        data: {
          academyName: row.academyName,
          showQrOnCertificates: row.showQrOnCertificates,
          autoIssueOnCourseCompletion: row.autoIssueOnCourseCompletion,
          autoIssueOnQuizCompletion: row.autoIssueOnQuizCompletion,
        },
      });

      await adminAudit(tx, {
        action: 'certificate.settings_updated',
        actorId: auth.userId,
        entityType: 'certificate_settings',
        entityId: '00000000-0000-4000-8000-000000000001',
        data: { settingsKey: 'default' },
      });

      return row;
    });

    return toSettingsDto(updated);
  },

  async searchStudents(
    query: CertificateStudentSearchQuery,
  ): Promise<CertificateStudentLookupDto[]> {
    const q = query.q;
    const rows = await prisma.user.findMany({
      where: {
        roles: { some: { role: { key: 'STUDENT' } } },
        OR: [
          { fullName: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { studentProfile: { studentCode: { contains: q, mode: 'insensitive' } } },
        ],
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        status: true,
        studentProfile: {
          select: {
            studentCode: true,
            class: { select: { name: true } },
            stream: { select: { name: true } },
          },
        },
      },
      orderBy: [{ fullName: 'asc' }],
      take: query.limit,
    });

    return rows.map((row) => ({
      userId: row.id,
      fullName: row.fullName,
      email: row.email,
      studentCode: row.studentProfile?.studentCode ?? null,
      className: row.studentProfile?.class?.name ?? null,
      streamName: row.studentProfile?.stream?.name ?? null,
      status: row.status,
    }));
  },

  async listSourceOptions(): Promise<{
    courses: CertificateSourceOptionDto[];
    academyQuizzes: CertificateSourceOptionDto[];
    examinations: CertificateSourceOptionDto[];
  }> {
    const [courses, academyQuizzes, examinations] = await Promise.all([
      prisma.course.findMany({
        where: { status: { in: ['PUBLISHED', 'DRAFT'] } },
        select: { id: true, title: true, status: true },
        orderBy: { title: 'asc' },
        take: 100,
      }),
      prisma.academyQuiz.findMany({
        select: { id: true, title: true, slug: true, status: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.examination.findMany({
        select: { id: true, title: true, course: { select: { title: true } } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);

    return {
      courses: courses.map((c) => ({ id: c.id, title: c.title, subtitle: c.status })),
      academyQuizzes: academyQuizzes.map((q) => ({ id: q.id, title: q.title, subtitle: q.slug })),
      examinations: examinations.map((e) => ({
        id: e.id,
        title: e.title,
        subtitle: e.course.title,
      })),
    };
  },

  async listAuditLogs(
    query: CertificateAuditQuery,
  ): Promise<Paginated<CertificateAuditLogItemDto>> {
    const { skip, take } = pageArgs(query);
    const where: Prisma.CertificateAuditLogWhereInput = {
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.certificateId ? { certificateId: query.certificateId } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.certificateAuditLog.findMany({
        where,
        skip,
        take,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        include: { actor: { select: { id: true, fullName: true } } },
      }),
      prisma.certificateAuditLog.count({ where }),
    ]);

    return paginated(
      rows.map((r) => ({
        id: r.id,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        certificateId: r.certificateId,
        actor: r.actor ? { userId: r.actor.id, fullName: r.actor.fullName } : null,
        data:
          r.data && typeof r.data === 'object' && !Array.isArray(r.data)
            ? (r.data as Record<string, unknown>)
            : null,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      query,
    );
  },
};
