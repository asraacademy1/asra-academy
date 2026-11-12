import type { QuizCertificateBatchStatus, QuizCertificateFormat } from '@asra/types';
import { QUIZ_CERT_CLAIM_LEASE_MS, QUIZ_CERT_SWEEP_MS } from '../../config/constants.js';
import { prisma } from '../../database/prisma.js';
import { emailService } from '../../email/email.service.js';
import { ResendDeliveryError } from '../../email/transports.js';
import { clock } from '../../lib/clock.js';
import { logger } from '../../lib/logger.js';
import { adminAudit } from '../admin/audit.js';
import { buildVerificationUrl } from '../certificates/bootstrap.js';
import {
  allocateCertificateNumber,
  createCertificateInsideTx,
  loadSignatureBuffers,
  resolveTemplateAndSnapshots,
} from '../certificates/certificates.service.js';
import { generateCertificatePdf as renderPdf } from '../certificates/pdf.service.js';
import { generateCertificatePng as renderPng } from '../certificates/png.service.js';
import {
  buildQuizCertificateTexts,
  renderQuizCertificateEmail,
} from './quiz-certificates.email.js';

type TestFailureHook =
  ((item: { id: string; userId: string; recipientEmail: string }) => void) | null;
let testGenerationHook: TestFailureHook = null;

/** Test-only hook to simulate partial certificate generation failures deterministically. */
export function setQuizCertificateGenerationHookForTests(hook: TestFailureHook): TestFailureHook {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setQuizCertificateGenerationHookForTests is only available in tests');
  }
  const previous = testGenerationHook;
  testGenerationHook = hook;
  return previous;
}

function safeErrorText(error: unknown): string {
  if (error instanceof ResendDeliveryError) {
    return `Resend rejected the message (${error.code}, status ${error.statusCode ?? 'none'})`.slice(
      0,
      490,
    );
  }
  if (error instanceof Error) {
    return error.message.slice(0, 490) || error.name;
  }
  return 'Unexpected error';
}

function formatsArrayOf(format: QuizCertificateFormat): ('PDF' | 'PNG')[] {
  if (format === 'PDF') return ['PDF'];
  if (format === 'PNG') return ['PNG'];
  return ['PDF', 'PNG'];
}

export async function refreshBatchAggregates(batchId: string): Promise<void> {
  const batch = await prisma.quizCertificateIssuanceBatch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      quizId: true,
      initiatedById: true,
      sendEmail: true,
      totalQueued: true,
      status: true,
      startedAt: true,
    },
  });
  if (!batch) return;

  const [genGroups, emailGroups] = await Promise.all([
    prisma.quizCertificateIssuanceItem.groupBy({
      by: ['generationStatus'],
      where: { batchId },
      _count: { _all: true },
    }),
    prisma.quizCertificateIssuanceItem.groupBy({
      by: ['emailStatus'],
      where: { batchId },
      _count: { _all: true },
    }),
  ]);

  const genCount = (status: string) =>
    genGroups.find((g) => g.generationStatus === status)?._count._all ?? 0;
  const emailCount = (status: string) =>
    emailGroups.find((g) => g.emailStatus === status)?._count._all ?? 0;

  const generatedCount = genCount('GENERATED');
  const generationFailedCount = genCount('FAILED');
  const pendingGenCount = genCount('PENDING') + genCount('PROCESSING');

  const emailsSentCount = emailCount('SENT');
  const emailsFailedCount = emailCount('FAILED');
  const pendingEmailsCount = batch.sendEmail
    ? await prisma.quizCertificateIssuanceItem.count({
        where: {
          batchId,
          generationStatus: 'GENERATED',
          emailStatus: { in: ['PENDING', 'SENDING'] },
        },
      })
    : 0;

  let nextStatus: QuizCertificateBatchStatus;
  if (pendingGenCount > 0 || pendingEmailsCount > 0) {
    nextStatus = 'PROCESSING';
  } else if (batch.totalQueued > 0 && generationFailedCount === batch.totalQueued) {
    nextStatus = 'FAILED';
  } else if (generationFailedCount > 0 || emailsFailedCount > 0) {
    nextStatus = 'COMPLETED_WITH_ERRORS';
  } else {
    nextStatus = 'COMPLETED';
  }

  const now = clock.now();
  const isTerminal =
    nextStatus === 'COMPLETED' || nextStatus === 'COMPLETED_WITH_ERRORS' || nextStatus === 'FAILED';

  await prisma.quizCertificateIssuanceBatch.update({
    where: { id: batchId },
    data: {
      status: nextStatus,
      generatedCount,
      generationFailedCount,
      emailsSentCount,
      emailsFailedCount,
      ...(batch.startedAt ? {} : { startedAt: now }),
      completedAt: isTerminal ? now : null,
    },
  });

  if (
    isTerminal &&
    batch.status !== nextStatus &&
    (batch.status === 'PENDING' || batch.status === 'PROCESSING')
  ) {
    await adminAudit(prisma, {
      action: 'quiz_certificates.batch_completed',
      actorId: batch.initiatedById,
      entityType: 'academy_quiz',
      entityId: batch.quizId,
      data: {
        batchId,
        status: nextStatus,
        generatedCount,
        generationFailedCount,
        emailsSentCount,
        emailsFailedCount,
      },
    }).catch((err: unknown) => {
      logger.warn({ err, batchId }, 'Could not write batch completion audit log');
    });
  }
}

export async function processQuizCertificateEmail(itemId: string): Promise<boolean> {
  const now = clock.now();
  const leaseCutoff = new Date(now.getTime() - QUIZ_CERT_CLAIM_LEASE_MS);

  const claimed = await prisma.quizCertificateIssuanceItem.updateMany({
    where: {
      id: itemId,
      generationStatus: 'GENERATED',
      certificateId: { not: null },
      OR: [
        { emailStatus: 'PENDING' },
        { emailStatus: 'SENDING', emailClaimedAt: { lt: leaseCutoff } },
      ],
    },
    data: {
      emailStatus: 'SENDING',
      emailClaimedAt: now,
      emailAttempts: { increment: 1 },
    },
  });
  if (claimed.count === 0) return false;

  const item = await prisma.quizCertificateIssuanceItem.findUniqueOrThrow({
    where: { id: itemId },
    include: {
      batch: { select: { id: true, format: true, showInStudentDashboard: true } },
      quiz: { select: { id: true, title: true } },
      user: { select: { id: true, fullName: true, email: true, status: true } },
    },
  });

  const mine = {
    id: item.id,
    emailStatus: 'SENDING' as const,
    emailClaimedAt: now,
  };

  try {
    if (!item.certificateId || !item.certificateNumber) {
      throw new Error('Certificate record is not available for email delivery.');
    }
    if (item.user.status !== 'ACTIVE') {
      throw new Error('Student account is not active.');
    }
    const targetEmail = (item.user.email || item.recipientEmail).trim();
    if (!targetEmail) {
      throw new Error('Recipient email address is missing.');
    }

    const rendered = renderQuizCertificateEmail({
      recipientName: item.user.fullName || item.recipientName,
      quizTitle: item.quiz.title,
      category: item.category,
      rank: item.rank,
      certificateId: item.certificateId,
      certificateNumber: item.certificateNumber,
      issuedAt: item.issuedAt ?? now,
      format: item.batch.format,
      showInStudentDashboard: item.batch.showInStudentDashboard,
    });

    const receipt = await emailService.sendNotification(
      targetEmail,
      rendered,
      `quiz-cert-email/${item.id}`,
    );

    await prisma.quizCertificateIssuanceItem.updateMany({
      where: mine,
      data: {
        emailStatus: 'SENT',
        emailSentAt: clock.now(),
        emailProviderMessageId: receipt.providerMessageId ?? null,
        emailError: null,
        emailClaimedAt: null,
      },
    });
  } catch (error) {
    const errText = safeErrorText(error);
    await prisma.quizCertificateIssuanceItem.updateMany({
      where: mine,
      data: {
        emailStatus: 'FAILED',
        emailError: errText,
        emailClaimedAt: null,
      },
    });
    logger.warn(
      { itemId: item.id, batchId: item.batchId, err: errText },
      'Quiz certificate email failed',
    );
  }

  await refreshBatchAggregates(item.batchId);
  return true;
}

export async function processQuizCertificateItem(itemId: string): Promise<boolean> {
  const now = clock.now();
  const leaseCutoff = new Date(now.getTime() - QUIZ_CERT_CLAIM_LEASE_MS);

  const claimed = await prisma.quizCertificateIssuanceItem.updateMany({
    where: {
      id: itemId,
      OR: [
        { generationStatus: 'PENDING' },
        { generationStatus: 'PROCESSING', claimedAt: { lt: leaseCutoff } },
      ],
    },
    data: {
      generationStatus: 'PROCESSING',
      claimedAt: now,
      generationAttempts: { increment: 1 },
    },
  });
  if (claimed.count === 0) return false;

  const item = await prisma.quizCertificateIssuanceItem.findUniqueOrThrow({
    where: { id: itemId },
    include: {
      batch: true,
      quiz: { select: { id: true, title: true } },
      user: {
        select: {
          id: true,
          fullName: true,
          email: true,
          studentProfile: { select: { studentCode: true } },
        },
      },
      attempt: { select: { id: true, submittedAt: true } },
      template: { select: { id: true, defaultTitle: true, defaultBodyText: true } },
    },
  });

  const mine = {
    id: item.id,
    generationStatus: 'PROCESSING' as const,
    claimedAt: now,
  };

  try {
    if (testGenerationHook) {
      testGenerationHook({
        id: item.id,
        userId: item.userId,
        recipientEmail: item.recipientEmail,
      });
    }

    const issuedAt = clock.now();
    const completedAt = item.attempt.submittedAt ?? issuedAt;
    const recipientName = item.user.fullName || item.recipientName;
    const recipientEmail = item.user.email || item.recipientEmail;
    const pct = item.percent !== null ? Number(item.percent) : null;

    const texts = buildQuizCertificateTexts({
      quizTitle: item.quiz.title,
      category: item.category,
      rank: item.rank,
      percent: pct,
      templateDefaultTitle: item.template.defaultTitle,
      templateDefaultBody: item.template.defaultBodyText,
    });

    const snapshots = await resolveTemplateAndSnapshots(prisma, {
      templateId: item.templateId,
      certificateTitle: texts.certificateTitle,
      description: texts.description,
    });

    const { buffers: signatureBuffers, missing } = await loadSignatureBuffers(
      snapshots.signatureSnapshots,
    );
    if (missing.length > 0) {
      throw new Error(
        `Missing ${missing.length} digital signature asset(s) required for rendering.`,
      );
    }

    const certNumber = await allocateCertificateNumber(prisma, issuedAt.getUTCFullYear());
    const verificationUrl = buildVerificationUrl(certNumber);
    const renderInput = {
      certificateNumber: certNumber,
      recipientName,
      certificateTitle: snapshots.templateSnapshot.certificateTitle,
      courseTitle: item.quiz.title,
      description: texts.description,
      achievementDetails: texts.achievementDetails,
      sourceType: 'ACADEMY_QUIZ' as const,
      sourceLabel: 'Academy Quiz',
      completedAt,
      issuedAt,
      status: 'ISSUED' as const,
      lifecycleStatus: 'ISSUED' as const,
      verificationUrl,
      templateSnapshot: snapshots.templateSnapshot,
      signatureSnapshots: snapshots.signatureSnapshots,
      signatureBuffers,
    };

    try {
      if (item.batch.format === 'PDF' || item.batch.format === 'BOTH') {
        await renderPdf(renderInput);
      }
      if (item.batch.format === 'PNG' || item.batch.format === 'BOTH') {
        await renderPng(renderInput);
      }
    } finally {
      signatureBuffers.clear();
    }

    const idempotencyKey = `ACADEMY_QUIZ:${item.quizId}:${item.category}:${item.userId}`;
    const issuedFormats = formatsArrayOf(item.batch.format);

    const committedCert = await prisma.$transaction(async (tx) => {
      // Check if an active ISSUED certificate already exists for this quiz+user+category (including legacy null category for PARTICIPATION)
      const existingActive = await tx.certificate.findFirst({
        where: {
          academyQuizId: item.quizId,
          userId: item.userId,
          status: 'ISSUED',
          ...(item.category === 'PARTICIPATION'
            ? { OR: [{ certificateCategory: 'PARTICIPATION' }, { certificateCategory: null }] }
            : { certificateCategory: 'RANK' }),
        },
        select: { id: true, certificateNumber: true, issuedAt: true },
      });

      let certId: string;
      let certNum: string;
      let certIssuedAt: Date;

      if (existingActive) {
        certId = existingActive.id;
        certNum = existingActive.certificateNumber;
        certIssuedAt = existingActive.issuedAt;
      } else {
        const created = await createCertificateInsideTx(tx, {
          sourceType: 'ACADEMY_QUIZ',
          sourceReferenceId: item.quizId,
          sourceLabel: 'Academy Quiz',
          userId: item.userId,
          academyQuizId: item.quizId,
          recipientName,
          recipientEmail,
          recipientStudentCode: item.user.studentProfile?.studentCode ?? null,
          templateId: snapshots.templateId,
          certificateTitle: texts.certificateTitle,
          subjectTitle: item.quiz.title,
          description: texts.description,
          achievementDetails: texts.achievementDetails,
          completedAt,
          issuedAt,
          idempotencyKey,
          adminActorId: item.issuedById ?? item.batch.initiatedById,
          visibleInStudentDashboard: item.batch.showInStudentDashboard,
          certificateCategory: item.category,
          quizRank: item.rank,
          quizAttemptId: item.attemptId,
          issuedFormats,
          skipNotification: !item.batch.showInStudentDashboard,
          skipEmailNotification: true,
          notificationMessage:
            item.category === 'RANK' && item.rank !== null
              ? `Congratulations! Your Rank #${item.rank} certificate for "${item.quiz.title}" has been issued.`
              : `Congratulations! Your participation certificate for "${item.quiz.title}" has been issued.`,
          preallocatedCertificateNumber: certNumber,
          precomputedSnapshots: snapshots,
          metadata: {
            quizBatchId: item.batchId,
            quizAttemptId: item.attemptId,
            category: item.category,
            rank: item.rank,
            score: item.score !== null ? Number(item.score) : null,
            percent: pct,
          },
        });
        certId = created.certificate.id;
        certNum = created.certificate.certificateNumber;
        certIssuedAt = created.certificate.issuedAt;
      }

      const pdfRef =
        item.batch.format === 'PDF' || item.batch.format === 'BOTH'
          ? `/api/v1/student/certificates/${certId}/download/pdf`
          : null;
      const pngRef =
        item.batch.format === 'PNG' || item.batch.format === 'BOTH'
          ? `/api/v1/student/certificates/${certId}/download/png`
          : null;

      await tx.quizCertificateIssuanceItem.updateMany({
        where: mine,
        data: {
          generationStatus: 'GENERATED',
          generationError: null,
          claimedAt: null,
          certificateId: certId,
          certificateNumber: certNum,
          pdfReference: pdfRef,
          pngReference: pngRef,
          issuedAt: certIssuedAt,
        },
      });

      return { certId, certNum };
    });

    await refreshBatchAggregates(item.batchId);

    if (item.batch.sendEmail && committedCert.certId) {
      await processQuizCertificateEmail(item.id);
    }
  } catch (error) {
    const errText = safeErrorText(error);
    await prisma.quizCertificateIssuanceItem.updateMany({
      where: mine,
      data: {
        generationStatus: 'FAILED',
        generationError: errText,
        claimedAt: null,
      },
    });
    logger.warn(
      { itemId: item.id, batchId: item.batchId, err: errText },
      'Quiz certificate generation failed',
    );
    await refreshBatchAggregates(item.batchId);
  }

  return true;
}

export async function processBatchJobs(batchId: string): Promise<void> {
  await prisma.quizCertificateIssuanceBatch.updateMany({
    where: { id: batchId, status: 'PENDING' },
    data: { status: 'PROCESSING', startedAt: clock.now() },
  });

  const pendingGenItems = await prisma.quizCertificateIssuanceItem.findMany({
    where: { batchId, generationStatus: 'PENDING' },
    orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }],
    select: { id: true },
  });

  for (const item of pendingGenItems) {
    await processQuizCertificateItem(item.id);
  }

  const pendingEmailItems = await prisma.quizCertificateIssuanceItem.findMany({
    where: {
      batchId,
      generationStatus: 'GENERATED',
      certificateId: { not: null },
      emailStatus: 'PENDING',
    },
    orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }],
    select: { id: true },
  });

  for (const item of pendingEmailItems) {
    await processQuizCertificateEmail(item.id);
  }

  await refreshBatchAggregates(batchId);
}

const inFlightBatches = new Set<Promise<void>>();

/**
 * Triggers asynchronous processing of a quiz certificate issuance batch without blocking
 * the HTTP response. Tracked in `inFlightBatches` for graceful shutdown and test settling.
 */
export function dispatchQuizCertificateBatch(batchId: string): void {
  const run = (async () => {
    try {
      await processBatchJobs(batchId);
    } catch (error) {
      logger.error({ err: error, batchId }, 'Quiz certificate batch processing error');
      await refreshBatchAggregates(batchId).catch(() => undefined);
    }
  })();
  inFlightBatches.add(run);
  void run.finally(() => inFlightBatches.delete(run));
}

export async function settleQuizCertificateDispatch(): Promise<void> {
  while (inFlightBatches.size > 0) {
    await Promise.allSettled([...inFlightBatches]);
  }
}

export async function sweepQuizCertificateJobs(): Promise<number> {
  const now = clock.now();
  const leaseCutoff = new Date(now.getTime() - QUIZ_CERT_CLAIM_LEASE_MS);
  let processed = 0;

  const dueGeneration = await prisma.quizCertificateIssuanceItem.findMany({
    where: {
      OR: [
        { generationStatus: 'PENDING' },
        { generationStatus: 'PROCESSING', claimedAt: { lt: leaseCutoff } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: 25,
    select: { id: true },
  });

  for (const item of dueGeneration) {
    if (await processQuizCertificateItem(item.id)) processed += 1;
  }

  const dueEmails = await prisma.quizCertificateIssuanceItem.findMany({
    where: {
      generationStatus: 'GENERATED',
      certificateId: { not: null },
      OR: [
        { emailStatus: 'PENDING' },
        { emailStatus: 'SENDING', emailClaimedAt: { lt: leaseCutoff } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: 25,
    select: { id: true },
  });

  for (const item of dueEmails) {
    if (await processQuizCertificateEmail(item.id)) processed += 1;
  }

  return processed;
}

export function startQuizCertificateWorker(intervalMs = QUIZ_CERT_SWEEP_MS): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweepQuizCertificateJobs();
    } catch (error) {
      const { name, code } = error as { name?: string; code?: string };
      logger.warn({ errorName: name, errorCode: code }, 'Quiz certificate sweep failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
