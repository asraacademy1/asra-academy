import type {
  QuizCertificateBatchDetailDto,
  QuizCertificateBatchSummaryDto,
  QuizCertificateCategory,
  QuizCertificateFormat,
  QuizCertificateIssuanceItemDto,
  QuizCertificatePreviewRecipientDto,
  QuizCertificatePreviewResponseDto,
  QuizCertificateSummaryDto,
  QuizCertificateTemplateAssignmentDto,
  QuizEligibleParticipantDto,
  QuizEligibleParticipantsResponseDto,
  QuizIssuedCertificateItemDto,
  Paginated,
} from '@asra/types';
import {
  isArtworkCertificateStyle,
  type QuizCertificateBatchItemsQuery,
  type QuizCertificateEligibleQuery,
  type QuizCertificateIssuanceRequestInput,
  type QuizCertificateRetryInput,
  type QuizCertificateSamplePreviewInput,
  type QuizIssuedCertificatesQuery,
} from '@asra/validation';
import { prisma } from '../../database/prisma.js';
import type { DbClient } from '../../database/types.js';
import { Prisma } from '../../generated/prisma/client.js';
import { clock } from '../../lib/clock.js';
import type { AuthContext } from '../../types/auth.js';
import { AppError, fieldError } from '../../utils/app-error.js';
import { pageArgs, paginated } from '../../utils/pagination.js';
import { adminAudit } from '../admin/audit.js';
import {
  buildVerificationUrl,
  DEFAULT_FALLBACK_SIGNATURES,
  ensureCertificateDefaults,
  hydrateSignatureSnapshots,
  normalizeTemplateConfig,
  recordCertificateAudit,
  toAdminCertificateListItem,
} from '../certificates/bootstrap.js';
import { generateCertificatePdf } from '../certificates/pdf.service.js';
import { generateCertificatePng } from '../certificates/png.service.js';
import { certificateStorage } from '../certificates/storage.service.js';
import {
  assertTemplateSignatureRequirement,
  templateIssuanceProblem,
} from '../certificates/template-rules.js';
import {
  buildQuizCertificateTexts,
  renderQuizCertificateEmail,
} from './quiz-certificates.email.js';
import { dispatchQuizCertificateBatch } from './quiz-certificates.worker.js';
import {
  FINALIZING_MESSAGE,
  finalizeQuizBacklog,
  rankedAttemptsForQuiz,
} from './results.service.js';
import { phaseOf } from './selection.js';

const quizNotFound = (): never => {
  throw new AppError('NOT_FOUND', 'Academy quiz not found');
};

const batchNotFound = (): never => {
  throw new AppError('NOT_FOUND', 'Certificate issuance batch not found');
};

const COMPLETION_LABELS: Record<'DRAFT' | 'UPCOMING' | 'LIVE' | 'ENDED' | 'CLOSED', string> = {
  DRAFT: 'Draft (not started)',
  UPCOMING: 'Scheduled (not started)',
  LIVE: 'Quiz in progress',
  ENDED: 'Completed (ended)',
  CLOSED: 'Completed (closed)',
};

const templateInclude = {
  signatures: {
    include: { signature: true },
    orderBy: { sortOrder: 'asc' as const },
  },
} satisfies Prisma.CertificateTemplateInclude;

type TemplateRow = Prisma.CertificateTemplateGetPayload<{ include: typeof templateInclude }>;

function isTemplateValidForIssuance(tpl: TemplateRow): { valid: boolean; reason?: string } {
  // Shared rules: archived templates are rejected, and artwork templates (ASRA QUIZORA 2026)
  // require exactly their Event Coordinator + Director signatures — enforced before any batch
  // is created, previewed or processed.
  const problem = templateIssuanceProblem(tpl);
  return problem ? { valid: false, reason: problem } : { valid: true };
}

function assertQuizCompleted(
  quiz: { status: 'DRAFT' | 'PUBLISHED' | 'CLOSED'; startsAt: Date; endsAt: Date },
  now: Date,
): void {
  const phase = phaseOf(quiz, now);
  if (phase !== 'ENDED' && phase !== 'CLOSED') {
    throw new AppError(
      'BAD_REQUEST',
      phase === 'LIVE'
        ? 'Certificates cannot be issued while the quiz is still in progress.'
        : 'Certificates can only be issued after the quiz has completed.',
    );
  }
}

function parseRankFilter(raw: string | undefined): number[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1),
    ),
  ];
}

function toBatchSummaryDto(
  row: Prisma.QuizCertificateIssuanceBatchGetPayload<{
    include: { initiatedBy: { select: { fullName: true } } };
  }>,
): QuizCertificateBatchSummaryDto {
  const pendingGenerationCount = Math.max(
    0,
    row.totalQueued - row.generatedCount - row.generationFailedCount,
  );
  const pendingEmailCount = row.sendEmail
    ? Math.max(0, row.generatedCount - row.emailsSentCount - row.emailsFailedCount)
    : 0;

  const totalUnits = row.totalQueued * (row.sendEmail ? 2 : 1);
  const completedUnits =
    row.generatedCount +
    row.generationFailedCount +
    (row.sendEmail ? row.emailsSentCount + row.emailsFailedCount : 0);
  const completionPercent =
    totalUnits === 0 ? 100 : Math.min(100, Math.round((completedUnits / totalUnits) * 100));

  return {
    id: row.id,
    quizId: row.quizId,
    recipientMode: row.recipientMode,
    format: row.format,
    sendEmail: row.sendEmail,
    showInStudentDashboard: row.showInStudentDashboard,
    status: row.status,
    totalRecipients: row.totalRecipients,
    excludedDuplicates: row.excludedDuplicates,
    totalQueued: row.totalQueued,
    generatedCount: row.generatedCount,
    generationFailedCount: row.generationFailedCount,
    emailsSentCount: row.emailsSentCount,
    emailsFailedCount: row.emailsFailedCount,
    pendingGenerationCount,
    pendingEmailCount,
    completionPercent,
    initiatedByName: row.initiatedBy?.fullName ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toIssuanceItemDto(
  row: Prisma.QuizCertificateIssuanceItemGetPayload<{
    include: { template: { select: { name: true } } };
  }>,
): QuizCertificateIssuanceItemDto {
  return {
    id: row.id,
    batchId: row.batchId,
    userId: row.userId,
    recipientName: row.recipientName,
    recipientEmail: row.recipientEmail,
    attemptId: row.attemptId,
    templateId: row.templateId,
    templateName: row.template.name,
    category: row.category,
    rank: row.rank,
    score: row.score !== null ? Number(row.score) : null,
    percent: row.percent !== null ? Number(row.percent) : null,
    certificateId: row.certificateId,
    certificateNumber: row.certificateNumber,
    pdfReference: row.pdfReference,
    pngReference: row.pngReference,
    generationStatus: row.generationStatus,
    generationAttempts: row.generationAttempts,
    generationError: row.generationError,
    emailStatus: row.emailStatus,
    emailAttempts: row.emailAttempts,
    emailError: row.emailError,
    emailSentAt: row.emailSentAt?.toISOString() ?? null,
    issuedAt: row.issuedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadQuizAndEligibleData(quizId: string) {
  const quiz =
    (await prisma.academyQuiz.findUnique({
      where: { id: quizId },
      select: {
        id: true,
        slug: true,
        title: true,
        status: true,
        startsAt: true,
        endsAt: true,
        closedAt: true,
        attemptCounting: true,
        tieBreak: true,
      },
    })) ?? quizNotFound();

  const pendingFinalization = await finalizeQuizBacklog(quiz.id);
  const ranked = await rankedAttemptsForQuiz(quiz);

  const userIds = ranked.map((r) => r.userId);
  const [users, existingCerts, inFlightItems] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({
          where: { id: { in: userIds } },
          select: {
            id: true,
            email: true,
            fullName: true,
            studentProfile: { select: { studentCode: true } },
          },
        })
      : [],
    prisma.certificate.findMany({
      where: {
        academyQuizId: quiz.id,
        status: 'ISSUED',
      },
      select: {
        userId: true,
        certificateNumber: true,
        certificateCategory: true,
      },
    }),
    prisma.quizCertificateIssuanceItem.findMany({
      where: {
        quizId: quiz.id,
        generationStatus: { in: ['PENDING', 'PROCESSING'] },
      },
      select: {
        userId: true,
        category: true,
      },
    }),
  ]);

  const userById = new Map(users.map((u) => [u.id, u]));
  const participationCertByUser = new Map<string, string>();
  const rankCertByUser = new Map<string, string>();
  for (const cert of existingCerts) {
    if (!cert.userId) continue;
    if (cert.certificateCategory === 'RANK') {
      rankCertByUser.set(cert.userId, cert.certificateNumber);
    } else {
      // Null category (legacy self-claim) or explicit PARTICIPATION
      participationCertByUser.set(cert.userId, cert.certificateNumber);
    }
  }

  const inFlightParticipationUsers = new Set(
    inFlightItems.filter((i) => i.category === 'PARTICIPATION').map((i) => i.userId),
  );
  const inFlightRankUsers = new Set(
    inFlightItems.filter((i) => i.category === 'RANK').map((i) => i.userId),
  );

  const participants: QuizEligibleParticipantDto[] = ranked.map((entry) => {
    const user = userById.get(entry.userId);
    const participationCert = participationCertByUser.get(entry.userId) ?? null;
    const rankCert = rankCertByUser.get(entry.userId) ?? null;
    return {
      userId: entry.userId,
      fullName: user?.fullName ?? entry.fullName,
      email: user?.email ?? '',
      studentCode: user?.studentProfile?.studentCode ?? null,
      attemptId: entry.attemptId,
      attemptNumber: entry.attemptNumber,
      score: entry.scoreCents / 100,
      maxScore: entry.maxScoreCents / 100,
      percent: entry.percent,
      timeTakenSeconds: entry.timeTakenSeconds,
      submittedAt: entry.submittedAt.toISOString(),
      rank: entry.rank,
      alreadyIssuedParticipation: participationCert !== null,
      participationCertificateNumber: participationCert,
      alreadyIssuedRank: rankCert !== null,
      rankCertificateNumber: rankCert,
      inFlightParticipation: inFlightParticipationUsers.has(entry.userId),
      inFlightRank: inFlightRankUsers.has(entry.userId),
    };
  });

  const availableRanks = [...new Set(participants.map((p) => p.rank))].sort((a, b) => a - b);

  return {
    quiz,
    pendingFinalization,
    participants,
    availableRanks,
    existingCertsCount: existingCerts.length,
    issuedParticipationCount: existingCerts.filter((c) => c.certificateCategory !== 'RANK').length,
    issuedRankCount: existingCerts.filter((c) => c.certificateCategory === 'RANK').length,
    inFlightCount: inFlightItems.length,
  };
}

function filterParticipants(
  participants: QuizEligibleParticipantDto[],
  filter: {
    mode?: 'ALL_PARTICIPANTS' | 'RANKERS_ONLY' | 'SELECTED_RANKS' | 'INDIVIDUAL_PARTICIPANTS';
    topN?: number | null;
    rankFrom?: number | null;
    rankTo?: number | null;
    selectedRanks?: number[];
    selectedUserIds?: string[];
    search?: string;
  },
): QuizEligibleParticipantDto[] {
  let list = participants;

  if (filter.mode === 'RANKERS_ONLY') {
    if (typeof filter.rankFrom === 'number' && typeof filter.rankTo === 'number') {
      list = list.filter((p) => p.rank >= filter.rankFrom! && p.rank <= filter.rankTo!);
    } else if (typeof filter.topN === 'number') {
      list = list.filter((p) => p.rank <= filter.topN!);
    }
  } else if (filter.mode === 'SELECTED_RANKS' && filter.selectedRanks) {
    const allowed = new Set(filter.selectedRanks);
    list = list.filter((p) => allowed.has(p.rank));
  } else if (filter.mode === 'INDIVIDUAL_PARTICIPANTS' && filter.selectedUserIds) {
    const allowed = new Set(filter.selectedUserIds);
    list = list.filter((p) => allowed.has(p.userId));
  }

  if (filter.search) {
    const q = filter.search.trim().toLowerCase();
    list = list.filter(
      (p) =>
        p.fullName.toLowerCase().includes(q) ||
        p.email.toLowerCase().includes(q) ||
        (p.studentCode?.toLowerCase().includes(q) ?? false),
    );
  }

  return list;
}

async function loadValidatedTemplateMap(
  db: DbClient,
  assignment: QuizCertificateTemplateAssignmentDto,
): Promise<Map<string, TemplateRow>> {
  await ensureCertificateDefaults(db);
  const requestedIds = [
    ...new Set(
      [
        assignment.participationTemplateId,
        assignment.rank1TemplateId,
        assignment.rank2TemplateId,
        assignment.rank3TemplateId,
        assignment.otherRankTemplateId,
      ].filter((id): id is string => Boolean(id)),
    ),
  ];

  if (requestedIds.length === 0) {
    throw fieldError(
      'VALIDATION_ERROR',
      'templates',
      'Select at least one active certificate template.',
    );
  }

  const rows = await db.certificateTemplate.findMany({
    where: { id: { in: requestedIds } },
    include: templateInclude,
  });

  const byId = new Map<string, TemplateRow>();
  for (const id of requestedIds) {
    const tpl = rows.find((r) => r.id === id);
    if (!tpl) {
      throw fieldError(
        'VALIDATION_ERROR',
        'templates',
        'One of the selected certificate templates no longer exists.',
      );
    }
    const check = isTemplateValidForIssuance(tpl);
    if (!check.valid) {
      throw fieldError('VALIDATION_ERROR', 'templates', check.reason!);
    }
    byId.set(id, tpl);
  }

  return byId;
}

function resolveRankTemplateId(
  rank: number,
  assignment: QuizCertificateTemplateAssignmentDto,
): string | null {
  if (rank === 1) return assignment.rank1TemplateId || assignment.otherRankTemplateId || null;
  if (rank === 2) return assignment.rank2TemplateId || assignment.otherRankTemplateId || null;
  if (rank === 3) return assignment.rank3TemplateId || assignment.otherRankTemplateId || null;
  return assignment.otherRankTemplateId || null;
}

function planRecipientsAndTemplates(
  selected: QuizEligibleParticipantDto[],
  input: QuizCertificateIssuanceRequestInput,
  templateById: Map<string, TemplateRow>,
): {
  recipients: QuizCertificatePreviewRecipientDto[];
  participationTemplateName: string | null;
  rankTemplateAssignments: { label: string; templateId: string; templateName: string }[];
} {
  const t = input.templates;
  const rankAssignmentsMap = new Map<
    string,
    { label: string; templateId: string; templateName: string }
  >();

  const recipients: QuizCertificatePreviewRecipientDto[] = selected.map((participant) => {
    let category: QuizCertificateCategory;
    let templateId: string | null = null;

    if (input.recipientMode === 'RANKERS_ONLY' || input.recipientMode === 'SELECTED_RANKS') {
      category = 'RANK';
      templateId = resolveRankTemplateId(participant.rank, t);
      if (!templateId) {
        throw fieldError(
          'VALIDATION_ERROR',
          'templates',
          `Assign an active certificate template for Rank ${participant.rank} or select a General Rank template.`,
        );
      }
    } else if (input.recipientMode === 'INDIVIDUAL_PARTICIPANTS') {
      category = input.individualCategory ?? 'PARTICIPATION';
      if (category === 'RANK') {
        templateId = resolveRankTemplateId(participant.rank, t);
        if (!templateId) {
          throw fieldError(
            'VALIDATION_ERROR',
            'templates',
            `Assign an active certificate template for Rank ${participant.rank} or select a General Rank template.`,
          );
        }
      } else {
        templateId = t.participationTemplateId || null;
        if (!templateId) {
          throw fieldError(
            'VALIDATION_ERROR',
            'templates.participationTemplateId',
            'Select an active Participation certificate template.',
          );
        }
      }
    } else {
      // ALL_PARTICIPANTS: top rankers (1, 2, 3) receive special Rank certificates if assigned and enabled;
      // everyone else receives Participation certificates.
      const useRankForTop =
        t.issueRankCertificatesToTopRankers !== false &&
        participant.rank >= 1 &&
        participant.rank <= 3;
      const rankTplId =
        useRankForTop && participant.rank === 1
          ? t.rank1TemplateId || null
          : useRankForTop && participant.rank === 2
            ? t.rank2TemplateId || null
            : useRankForTop && participant.rank === 3
              ? t.rank3TemplateId || null
              : null;

      if (rankTplId) {
        category = 'RANK';
        templateId = rankTplId;
      } else {
        category = 'PARTICIPATION';
        templateId = t.participationTemplateId || null;
        if (!templateId) {
          throw fieldError(
            'VALIDATION_ERROR',
            'templates.participationTemplateId',
            'Select an active Participation certificate template.',
          );
        }
      }
    }

    const template = templateById.get(templateId);
    if (!template) {
      throw fieldError(
        'VALIDATION_ERROR',
        'templates',
        'Selected certificate template is invalid.',
      );
    }

    if (category === 'RANK') {
      const label = participant.rank <= 3 ? `Rank ${participant.rank}` : 'Other Ranks (General)';
      if (!rankAssignmentsMap.has(label)) {
        rankAssignmentsMap.set(label, {
          label,
          templateId: template.id,
          templateName: template.name,
        });
      }
    }

    const alreadyIssued =
      category === 'PARTICIPATION'
        ? participant.alreadyIssuedParticipation
        : participant.alreadyIssuedRank;
    const inFlight =
      category === 'PARTICIPATION' ? participant.inFlightParticipation : participant.inFlightRank;
    const existingNumber =
      category === 'PARTICIPATION'
        ? participant.participationCertificateNumber
        : participant.rankCertificateNumber;

    return {
      userId: participant.userId,
      fullName: participant.fullName,
      email: participant.email,
      attemptId: participant.attemptId,
      rank: category === 'RANK' ? participant.rank : participant.rank,
      score: participant.score,
      maxScore: participant.maxScore,
      percent: participant.percent,
      category,
      templateId: template.id,
      templateName: template.name,
      excludedAsDuplicate: alreadyIssued || inFlight,
      duplicateReason: alreadyIssued
        ? `Already issued (${existingNumber ?? 'existing certificate'})`
        : inFlight
          ? 'Issuance currently in progress'
          : null,
      existingCertificateNumber: existingNumber,
    };
  });

  const participationTpl = t.participationTemplateId
    ? (templateById.get(t.participationTemplateId)?.name ?? null)
    : null;

  return {
    recipients,
    participationTemplateName: participationTpl,
    rankTemplateAssignments: [...rankAssignmentsMap.values()],
  };
}

export const quizCertificatesService = {
  async getSummary(quizId: string): Promise<QuizCertificateSummaryDto> {
    await ensureCertificateDefaults(prisma);
    const data = await loadQuizAndEligibleData(quizId);
    const now = clock.now();
    const phase = phaseOf(data.quiz, now);
    const isCompleted = phase === 'ENDED' || phase === 'CLOSED';

    const [templates, latestBatch] = await Promise.all([
      prisma.certificateTemplate.findMany({
        where: { isActive: true },
        include: templateInclude,
      }),
      prisma.quizCertificateIssuanceBatch.findFirst({
        where: { quizId: data.quiz.id },
        orderBy: { createdAt: 'desc' },
        include: { initiatedBy: { select: { fullName: true } } },
      }),
    ]);

    const activeValidTemplatesCount = templates.filter(
      (tpl) => isTemplateValidForIssuance(tpl).valid,
    ).length;

    const pendingParticipationCount = data.participants.filter(
      (p) => !p.alreadyIssuedParticipation && !p.inFlightParticipation,
    ).length;

    return {
      quizId: data.quiz.id,
      quizTitle: data.quiz.title,
      quizSlug: data.quiz.slug,
      status: data.quiz.status,
      phase,
      isCompleted,
      completionStatusLabel: COMPLETION_LABELS[phase],
      pendingFinalization: data.pendingFinalization,
      totalEligibleParticipants: data.participants.length,
      totalEligibleRankers: data.participants.length,
      alreadyIssuedCount: data.existingCertsCount,
      issuedParticipationCount: data.issuedParticipationCount,
      issuedRankCount: data.issuedRankCount,
      pendingIssuanceCount: pendingParticipationCount,
      inFlightCount: data.inFlightCount,
      activeValidTemplatesCount,
      latestBatch: latestBatch ? toBatchSummaryDto(latestBatch) : null,
    };
  },

  async listEligible(
    quizId: string,
    query: QuizCertificateEligibleQuery,
  ): Promise<QuizEligibleParticipantsResponseDto> {
    const data = await loadQuizAndEligibleData(quizId);
    const phase = phaseOf(data.quiz, clock.now());
    const isCompleted = phase === 'ENDED' || phase === 'CLOSED';

    const selectedRanks = parseRankFilter(query.ranks);
    const filtered = filterParticipants(data.participants, {
      mode: query.mode,
      topN: query.topN ?? null,
      rankFrom: query.rankFrom ?? null,
      rankTo: query.rankTo ?? null,
      selectedRanks,
      search: query.search,
    });

    return {
      quizId: data.quiz.id,
      isCompleted,
      pendingFinalization: data.pendingFinalization,
      totalEligibleParticipants: data.participants.length,
      availableRanks: data.availableRanks,
      items: filtered,
    };
  },

  async previewIssuance(
    quizId: string,
    input: QuizCertificateIssuanceRequestInput,
  ): Promise<QuizCertificatePreviewResponseDto> {
    const data = await loadQuizAndEligibleData(quizId);
    assertQuizCompleted(data.quiz, clock.now());
    if (data.pendingFinalization > 0) {
      throw new AppError('CONFLICT', FINALIZING_MESSAGE);
    }

    const templateById = await loadValidatedTemplateMap(prisma, input.templates);
    const selected = filterParticipants(data.participants, {
      mode: input.recipientMode,
      topN: input.topN ?? null,
      rankFrom: input.rankFrom ?? null,
      rankTo: input.rankTo ?? null,
      selectedRanks: input.selectedRanks,
      selectedUserIds: input.selectedUserIds,
    });

    const { recipients, participationTemplateName, rankTemplateAssignments } =
      planRecipientsAndTemplates(selected, input, templateById);

    const excludedCount = recipients.filter((r) => r.excludedAsDuplicate).length;
    const toGenerateCount = recipients.length - excludedCount;
    const sampleRecipient = recipients.find((r) => !r.excludedAsDuplicate) ??
      recipients[0] ?? {
        fullName: 'Amina Rahman',
        category:
          input.recipientMode === 'RANKERS_ONLY' || input.recipientMode === 'SELECTED_RANKS'
            ? ('RANK' as const)
            : ('PARTICIPATION' as const),
        rank: 1,
      };

    const emailPreview = renderQuizCertificateEmail({
      recipientName: sampleRecipient.fullName,
      quizTitle: data.quiz.title,
      category: sampleRecipient.category,
      rank: sampleRecipient.rank ?? null,
      certificateId: '00000000-0000-4000-8000-000000000001',
      certificateNumber: 'ASRA-2026-SMPL-DEMO',
      issuedAt: clock.now(),
      format: input.format as QuizCertificateFormat,
      showInStudentDashboard: input.showInStudentDashboard,
    });

    return {
      quiz: {
        id: data.quiz.id,
        title: data.quiz.title,
        slug: data.quiz.slug,
        completedAt: (data.quiz.closedAt ?? data.quiz.endsAt).toISOString(),
      },
      recipientMode: input.recipientMode,
      format: input.format,
      sendEmail: input.sendEmail,
      showInStudentDashboard: input.showInStudentDashboard,
      totalUniqueRecipients: recipients.length,
      toGenerateCount,
      alreadyIssuedExcludedCount: excludedCount,
      participationTemplateName,
      rankTemplateAssignments,
      recipients,
      emailPreview,
    };
  },

  async generateSamplePreview(
    quizId: string,
    input: QuizCertificateSamplePreviewInput,
  ): Promise<{ buffer: Buffer; filename: string; mimeType: 'application/pdf' | 'image/png' }> {
    await ensureCertificateDefaults(prisma);
    const [quiz, tpl, settings] = await Promise.all([
      prisma.academyQuiz.findUnique({
        where: { id: quizId },
        select: { id: true, title: true, closedAt: true, endsAt: true },
      }),
      prisma.certificateTemplate.findUnique({
        where: { id: input.templateId },
        include: templateInclude,
      }),
      prisma.certificateSettings.findUnique({ where: { id: 'default' } }),
    ]);

    if (!quiz) return quizNotFound();
    if (!tpl) throw new AppError('NOT_FOUND', 'Certificate template not found');
    const validCheck = isTemplateValidForIssuance(tpl);
    if (!validCheck.valid) {
      throw fieldError('VALIDATION_ERROR', 'templateId', validCheck.reason!);
    }

    const buffers = new Map<string, Buffer>();
    const signatureSnapshots = [];
    for (const link of tpl.signatures) {
      if (!link.signature.isActive) continue;
      const buf = await certificateStorage().readSignaturePng(
        link.signature.storageProvider,
        link.signature.storageKey,
        link.signature.imageUrl,
      );
      if (!buf || buf.length === 0) {
        throw new AppError(
          'SERVICE_UNAVAILABLE',
          'Digital signature image is temporarily unavailable.',
        );
      }
      buffers.set(link.signature.id, buf);
      signatureSnapshots.push({
        signatureId: link.signature.id,
        fullName: link.signature.fullName,
        designation: link.signature.designation,
        department: link.signature.department,
        positionLabel: link.positionLabel,
        sortOrder: link.sortOrder,
        showName: link.showName,
        showDesignation: link.showDesignation,
        storageProvider: link.signature.storageProvider,
        storageKey: link.signature.storageKey,
        imageUrl: link.signature.imageUrl,
        width: link.signature.width,
        height: link.signature.height,
        isFallback: false,
      });
    }
    const isArtwork = isArtworkCertificateStyle(tpl.style);
    if (isArtwork) {
      // Mandatory signatures — the sample is refused rather than rendered with placeholders.
      assertTemplateSignatureRequirement(tpl, signatureSnapshots);
    } else if (signatureSnapshots.length === 0) {
      signatureSnapshots.push(...DEFAULT_FALLBACK_SIGNATURES);
    }

    const texts = buildQuizCertificateTexts({
      quizTitle: quiz.title,
      category: input.category,
      rank: input.rank ?? (input.category === 'RANK' ? 1 : null),
      percent: 96,
      templateDefaultTitle: tpl.defaultTitle,
      templateDefaultBody: tpl.defaultBodyText,
    });

    const sampleCode = 'ASRA-2026-QUIZ-DEMO';
    const now = clock.now();
    // Artwork template: heading + statement come from the template; no score / rank text.
    const certificateTitle = isArtwork ? tpl.defaultTitle : texts.certificateTitle;
    const description = isArtwork ? tpl.defaultBodyText : texts.description;
    const renderInput = {
      certificateNumber: sampleCode,
      recipientName: 'Fatima Zahra Al-Khatib',
      certificateTitle,
      courseTitle: quiz.title,
      description,
      achievementDetails: isArtwork ? null : texts.achievementDetails,
      sourceType: 'ACADEMY_QUIZ' as const,
      sourceLabel: 'Academy Quiz',
      completedAt: quiz.closedAt ?? quiz.endsAt,
      issuedAt: now,
      status: 'ISSUED' as const,
      lifecycleStatus: 'ISSUED' as const,
      verificationUrl: buildVerificationUrl(sampleCode),
      templateSnapshot: {
        templateId: tpl.id,
        key: tpl.key,
        name: tpl.name,
        style: tpl.style,
        version: tpl.version,
        certificateTitle,
        subtitle: settings?.academyTagline ?? tpl.defaultSubtitle,
        bodyText: description,
        issuingAuthority: settings?.academyName ?? tpl.issuingAuthority,
        config: { ...normalizeTemplateConfig(tpl.config), showQrCode: true },
      },
      signatureSnapshots,
      signatureBuffers: buffers,
    };

    try {
      if (input.format === 'png') {
        const buffer = await generateCertificatePng(renderInput);
        return {
          buffer,
          filename: `ASRA-Quiz-Preview-${tpl.key}.png`,
          mimeType: 'image/png',
        };
      }
      const buffer = await generateCertificatePdf(renderInput);
      return {
        buffer,
        filename: `ASRA-Quiz-Preview-${tpl.key}.pdf`,
        mimeType: 'application/pdf',
      };
    } finally {
      buffers.clear();
    }
  },

  async startBulkIssuance(
    auth: AuthContext,
    quizId: string,
    input: QuizCertificateIssuanceRequestInput,
  ): Promise<QuizCertificateBatchDetailDto> {
    const batchId = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('asra_quiz_cert_batch'), hashtext(${quizId}))`;

      const quiz =
        (await tx.academyQuiz.findUnique({
          where: { id: quizId },
          select: {
            id: true,
            slug: true,
            title: true,
            status: true,
            startsAt: true,
            endsAt: true,
            closedAt: true,
            attemptCounting: true,
            tieBreak: true,
          },
        })) ?? quizNotFound();

      assertQuizCompleted(quiz, clock.now());

      const data = await loadQuizAndEligibleData(quizId);
      if (data.pendingFinalization > 0) {
        throw new AppError('CONFLICT', FINALIZING_MESSAGE);
      }

      const templateById = await loadValidatedTemplateMap(tx, input.templates);
      const selected = filterParticipants(data.participants, {
        mode: input.recipientMode,
        topN: input.topN ?? null,
        rankFrom: input.rankFrom ?? null,
        rankTo: input.rankTo ?? null,
        selectedRanks: input.selectedRanks,
        selectedUserIds: input.selectedUserIds,
      });

      if (selected.length === 0) {
        throw new AppError('BAD_REQUEST', 'No eligible quiz participants matched your selection.');
      }

      const { recipients } = planRecipientsAndTemplates(selected, input, templateById);
      const toGenerate = recipients.filter((r) => !r.excludedAsDuplicate);
      const excludedDuplicates = recipients.length - toGenerate.length;

      if (toGenerate.length === 0) {
        throw new AppError(
          'BAD_REQUEST',
          'Certificates have already been issued (or are currently queued) for all selected recipients.',
        );
      }

      const createdBatch = await tx.quizCertificateIssuanceBatch.create({
        data: {
          quizId: quiz.id,
          initiatedById: auth.userId,
          recipientMode: input.recipientMode,
          format: input.format,
          sendEmail: input.sendEmail,
          showInStudentDashboard: input.showInStudentDashboard,
          templateConfig: input.templates as unknown as Prisma.InputJsonValue,
          status: 'PENDING',
          totalRecipients: recipients.length,
          excludedDuplicates,
          totalQueued: toGenerate.length,
        },
      });

      await tx.quizCertificateIssuanceItem.createMany({
        data: toGenerate.map((r) => ({
          batchId: createdBatch.id,
          quizId: quiz.id,
          userId: r.userId,
          attemptId: r.attemptId,
          templateId: r.templateId,
          category: r.category,
          rank: r.rank,
          score: new Prisma.Decimal(r.score),
          percent: new Prisma.Decimal(r.percent),
          recipientName: r.fullName,
          recipientEmail: r.email,
          generationStatus: 'PENDING',
          emailStatus: input.sendEmail ? 'PENDING' : 'NOT_REQUESTED',
          issuedById: auth.userId,
        })),
      });

      await adminAudit(tx, {
        action: 'quiz_certificates.bulk_issuance_started',
        actorId: auth.userId,
        entityType: 'academy_quiz',
        entityId: quiz.id,
        data: {
          batchId: createdBatch.id,
          recipientMode: input.recipientMode,
          format: input.format,
          sendEmail: input.sendEmail,
          showInStudentDashboard: input.showInStudentDashboard,
          totalRecipients: recipients.length,
          excludedDuplicates,
          totalQueued: toGenerate.length,
        },
      });

      await recordCertificateAudit(tx, {
        action: 'quiz_certificates.batch_created',
        actorId: auth.userId,
        entityType: 'certificate',
        entityId: createdBatch.id,
        data: {
          quizId: quiz.id,
          totalQueued: toGenerate.length,
          excludedDuplicates,
        },
      });

      return createdBatch.id;
    });

    dispatchQuizCertificateBatch(batchId);
    return quizCertificatesService.getBatchDetail(quizId, batchId, {});
  },

  async listBatches(quizId: string): Promise<QuizCertificateBatchSummaryDto[]> {
    const exists = await prisma.academyQuiz.findUnique({
      where: { id: quizId },
      select: { id: true },
    });
    if (!exists) quizNotFound();

    const rows = await prisma.quizCertificateIssuanceBatch.findMany({
      where: { quizId },
      orderBy: [{ createdAt: 'desc' }],
      take: 25,
      include: { initiatedBy: { select: { fullName: true } } },
    });

    return rows.map(toBatchSummaryDto);
  },

  async getBatchDetail(
    quizId: string,
    batchId: string,
    query: QuizCertificateBatchItemsQuery,
  ): Promise<QuizCertificateBatchDetailDto> {
    const batch =
      (await prisma.quizCertificateIssuanceBatch.findFirst({
        where: { id: batchId, quizId },
        include: { initiatedBy: { select: { fullName: true } } },
      })) ?? batchNotFound();

    const where: Prisma.QuizCertificateIssuanceItemWhereInput = {
      batchId: batch.id,
      ...(query.generationStatus ? { generationStatus: query.generationStatus } : {}),
      ...(query.emailStatus ? { emailStatus: query.emailStatus } : {}),
      ...(query.search
        ? {
            OR: [
              { recipientName: { contains: query.search, mode: 'insensitive' } },
              { recipientEmail: { contains: query.search, mode: 'insensitive' } },
              { certificateNumber: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, totalItems] = await Promise.all([
      prisma.quizCertificateIssuanceItem.findMany({
        where,
        include: { template: { select: { name: true } } },
        orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }],
      }),
      prisma.quizCertificateIssuanceItem.count({ where }),
    ]);

    return {
      batch: toBatchSummaryDto(batch),
      items: items.map(toIssuanceItemDto),
      totalItems,
    };
  },

  async retryBatch(
    auth: AuthContext,
    quizId: string,
    batchId: string,
    input: QuizCertificateRetryInput,
  ): Promise<QuizCertificateBatchDetailDto> {
    const resetCount = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('asra_quiz_cert_batch'), hashtext(${quizId}))`;

      const batch =
        (await tx.quizCertificateIssuanceBatch.findFirst({
          where: { id: batchId, quizId },
        })) ?? batchNotFound();

      let count = 0;
      const idFilter = input.itemIds?.length ? { id: { in: input.itemIds } } : {};

      if (input.scope === 'FAILED_GENERATIONS' || input.scope === 'ALL_FAILED') {
        const res = await tx.quizCertificateIssuanceItem.updateMany({
          where: {
            batchId: batch.id,
            generationStatus: 'FAILED',
            ...idFilter,
          },
          data: {
            generationStatus: 'PENDING',
            generationError: null,
            claimedAt: null,
          },
        });
        count += res.count;
      }

      if (batch.sendEmail && (input.scope === 'FAILED_EMAILS' || input.scope === 'ALL_FAILED')) {
        const res = await tx.quizCertificateIssuanceItem.updateMany({
          where: {
            batchId: batch.id,
            generationStatus: 'GENERATED',
            certificateId: { not: null },
            emailStatus: 'FAILED',
            ...idFilter,
          },
          data: {
            emailStatus: 'PENDING',
            emailError: null,
            emailClaimedAt: null,
          },
        });
        count += res.count;
      }

      if (count > 0) {
        await tx.quizCertificateIssuanceBatch.update({
          where: { id: batch.id },
          data: {
            status: 'PROCESSING',
            completedAt: null,
          },
        });

        await adminAudit(tx, {
          action: 'quiz_certificates.retry_requested',
          actorId: auth.userId,
          entityType: 'academy_quiz',
          entityId: quizId,
          data: {
            batchId: batch.id,
            scope: input.scope,
            itemsQueued: count,
          },
        });
      }

      return count;
    });

    if (resetCount > 0) {
      dispatchQuizCertificateBatch(batchId);
    }

    return quizCertificatesService.getBatchDetail(quizId, batchId, {});
  },

  async listIssuedCertificates(
    quizId: string,
    query: QuizIssuedCertificatesQuery,
  ): Promise<Paginated<QuizIssuedCertificateItemDto>> {
    const exists = await prisma.academyQuiz.findUnique({
      where: { id: quizId },
      select: { id: true },
    });
    if (!exists) quizNotFound();

    const { skip, take } = pageArgs(query);
    const where: Prisma.CertificateWhereInput = {
      academyQuizId: quizId,
      ...(query.category === 'RANK'
        ? { certificateCategory: 'RANK' }
        : query.category === 'PARTICIPATION'
          ? { OR: [{ certificateCategory: 'PARTICIPATION' }, { certificateCategory: null }] }
          : {}),
      ...(query.search
        ? {
            OR: [
              { certificateNumber: { contains: query.search, mode: 'insensitive' } },
              { recipientName: { contains: query.search, mode: 'insensitive' } },
              { recipientEmail: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.certificate.findMany({
        where,
        skip,
        take,
        orderBy: [{ quizRank: 'asc' }, { issuedAt: 'desc' }],
        include: {
          user: { select: { email: true } },
          issuedBy: { select: { fullName: true } },
          template: { select: { name: true } },
          reissues: {
            select: { certificateNumber: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
          quizIssuanceItems: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { emailStatus: true, emailSentAt: true },
          },
        },
      }),
      prisma.certificate.count({ where }),
    ]);

    const items: QuizIssuedCertificateItemDto[] = await Promise.all(
      rows.map(async (row) => {
        const base = toAdminCertificateListItem(
          row,
          await hydrateSignatureSnapshots(row.signatureSnapshots),
        );
        const latestItem = row.quizIssuanceItems[0];
        return {
          ...base,
          quizAttemptId: row.quizAttemptId ?? null,
          emailStatus: latestItem?.emailStatus ?? null,
          emailSentAt: latestItem?.emailSentAt?.toISOString() ?? null,
        };
      }),
    );

    return paginated(items, total, query);
  },
};
