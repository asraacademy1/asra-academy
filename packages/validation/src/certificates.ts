import {
  CERTIFICATE_SOURCE_TYPES,
  CERTIFICATE_TEMPLATE_STYLES,
  type CertificateSourceType,
} from '@asra/types';
import { z } from 'zod';
import { emailSchema, optionalTextSchema, paginationQuerySchema, uuidSchema } from './common.js';

export const CERTIFICATE_SIGNATURE_LIMITS = {
  minSignatures: 2,
  maxSignatures: 4,
  maxFileBytes: 512 * 1024, // 512 KB
  minWidth: 40,
  minHeight: 20,
  maxWidth: 2400,
  maxHeight: 1200,
} as const;

export const certificateSourceTypeSchema = z.enum(CERTIFICATE_SOURCE_TYPES);
export const certificateTemplateStyleSchema = z.enum(CERTIFICATE_TEMPLATE_STYLES);

export const certificateVerifyParamsSchema = z.object({
  certificateNumber: z
    .string()
    .trim()
    .min(3)
    .max(50)
    .regex(/^[A-Za-z0-9-]+$/, 'Certificate number can only contain letters, digits, and hyphens'),
});

export type CertificateVerifyParams = z.infer<typeof certificateVerifyParamsSchema>;

export const certificateCourseParamsSchema = z.object({
  courseId: uuidSchema,
});

export type CertificateCourseParams = z.infer<typeof certificateCourseParamsSchema>;

export const certificateIdParamSchema = z.object({
  id: uuidSchema,
});

export type CertificateIdParam = z.infer<typeof certificateIdParamSchema>;

export const certificateDownloadFormatSchema = z.enum(['pdf', 'png']).default('pdf');

export type CertificateDownloadFormat = z.infer<typeof certificateDownloadFormatSchema>;

export const certificateDownloadQuerySchema = z.object({
  format: certificateDownloadFormatSchema.optional(),
});

export type CertificateDownloadQuery = z.infer<typeof certificateDownloadQuerySchema>;

export const studentCertificateQuerySchema = paginationQuerySchema.extend({
  sourceType: certificateSourceTypeSchema.optional(),
  search: z.string().trim().max(100).optional(),
});

export type StudentCertificateQuery = z.infer<typeof studentCertificateQuerySchema>;

export const adminCertificateQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['ISSUED', 'REVOKED']).optional(),
  sourceType: certificateSourceTypeSchema.optional(),
  courseId: uuidSchema.optional(),
  academyQuizId: uuidSchema.optional(),
  studentId: uuidSchema.optional(),
});

export type AdminCertificateQuery = z.infer<typeof adminCertificateQuerySchema>;

export const adminRevokeCertificateSchema = z.object({
  reason: z.string().trim().min(3, 'Revocation reason must be at least 3 characters').max(500),
});

export type AdminRevokeCertificateInput = z.infer<typeof adminRevokeCertificateSchema>;

export const certificateTemplateConfigSchema = z.object({
  accentColor: z
    .string()
    .trim()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Use a 6-digit hex color')
    .default('#034729'),
  secondaryColor: z
    .string()
    .trim()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Use a 6-digit hex color')
    .default('#C88717'),
  showLogo: z.boolean().default(true),
  showSeal: z.boolean().default(true),
  showQrCode: z.boolean().default(true),
  showCompletionDate: z.boolean().default(true),
  showIssueDate: z.boolean().default(true),
  showCertificateNumber: z.boolean().default(true),
  showSourceLabel: z.boolean().default(true),
  footerNote: optionalTextSchema(250),
});

export type CertificateTemplateConfigInput = z.infer<typeof certificateTemplateConfigSchema>;

export const certificateSignaturePlacementSchema = z.object({
  signatureId: uuidSchema,
  sortOrder: z.number().int().min(0).max(3),
  positionLabel: z.string().trim().min(1).max(40),
  showName: z.boolean().default(true),
  showDesignation: z.boolean().default(true),
});

export type CertificateSignaturePlacementInput = z.infer<
  typeof certificateSignaturePlacementSchema
>;

function validateSignatureSelections(
  signatures: CertificateSignaturePlacementInput[],
  ctx: z.RefinementCtx,
  pathPrefix: string[] = ['signatures'],
) {
  if (
    signatures.length < CERTIFICATE_SIGNATURE_LIMITS.minSignatures ||
    signatures.length > CERTIFICATE_SIGNATURE_LIMITS.maxSignatures
  ) {
    ctx.addIssue({
      code: 'custom',
      path: pathPrefix,
      message: `Select between ${CERTIFICATE_SIGNATURE_LIMITS.minSignatures} and ${CERTIFICATE_SIGNATURE_LIMITS.maxSignatures} signatures`,
    });
    return;
  }
  const seenIds = new Set<string>();
  const seenOrders = new Set<number>();
  for (const sig of signatures) {
    if (seenIds.has(sig.signatureId)) {
      ctx.addIssue({
        code: 'custom',
        path: pathPrefix,
        message: 'Each signature can only be selected once per certificate',
      });
      return;
    }
    seenIds.add(sig.signatureId);
    if (seenOrders.has(sig.sortOrder)) {
      ctx.addIssue({
        code: 'custom',
        path: pathPrefix,
        message: 'Signature order positions must be unique',
      });
      return;
    }
    seenOrders.add(sig.sortOrder);
  }
}

export const updateCertificateTemplateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: optionalTextSchema(500),
    defaultTitle: z.string().trim().min(2).max(160).optional(),
    defaultSubtitle: optionalTextSchema(200),
    defaultBodyText: z.string().trim().min(5).max(1000).optional(),
    issuingAuthority: z.string().trim().min(2).max(160).optional(),
    isActive: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    config: certificateTemplateConfigSchema.partial().optional(),
    signatures: z.array(certificateSignaturePlacementSchema).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.signatures !== undefined) {
      validateSignatureSelections(val.signatures, ctx);
    }
  });

export type UpdateCertificateTemplateInput = z.infer<typeof updateCertificateTemplateSchema>;

export const createCertificateSignatureSchema = z.object({
  fullName: z.string().trim().min(2, 'Full name is required').max(150),
  designation: z.string().trim().min(2, 'Official designation is required').max(150),
  department: optionalTextSchema(150),
  isActive: z.boolean().default(true),
});

export type CreateCertificateSignatureInput = z.infer<typeof createCertificateSignatureSchema>;

export const updateCertificateSignatureSchema = z.object({
  fullName: z.string().trim().min(2).max(150).optional(),
  designation: z.string().trim().min(2).max(150).optional(),
  department: optionalTextSchema(150),
  isActive: z.boolean().optional(),
});

export type UpdateCertificateSignatureInput = z.infer<typeof updateCertificateSignatureSchema>;

export const certificateSignatureQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export type CertificateSignatureQuery = z.infer<typeof certificateSignatureQuerySchema>;

export const manualCertificateIssueSchema = z
  .object({
    recipientMode: z.enum(['EXISTING_STUDENT', 'MANUAL_RECIPIENT']),
    userId: uuidSchema.optional(),
    recipientName: z.string().trim().min(2, 'Recipient name is required').max(150),
    recipientEmail: z
      .union([z.literal(''), emailSchema])
      .nullable()
      .optional()
      .transform((v) => (v === '' ? null : v)),
    recipientStudentCode: optionalTextSchema(50),
    sourceType: certificateSourceTypeSchema.default('MANUAL'),
    sourceReferenceId: optionalTextSchema(120),
    sourceLabel: optionalTextSchema(120),
    courseId: uuidSchema.optional().nullable(),
    academyQuizId: uuidSchema.optional().nullable(),
    examinationId: uuidSchema.optional().nullable(),
    templateId: uuidSchema,
    certificateTitle: z.string().trim().min(2, 'Certificate title is required').max(160),
    subjectTitle: z
      .string()
      .trim()
      .min(2, 'Course / Achievement / Event name is required')
      .max(200),
    description: optionalTextSchema(1000),
    achievementDetails: optionalTextSchema(500),
    completedAt: z.iso.datetime().optional().nullable(),
    issuedAt: z.iso.datetime().optional().nullable(),
    signatures: z.array(certificateSignaturePlacementSchema),
    metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  })
  .superRefine((val, ctx) => {
    if (val.recipientMode === 'EXISTING_STUDENT' && !val.userId) {
      ctx.addIssue({
        code: 'custom',
        path: ['userId'],
        message: 'Select an existing student',
      });
    }
    validateSignatureSelections(val.signatures, ctx);
  });

export type ManualCertificateIssueInput = z.infer<typeof manualCertificateIssueSchema>;

export const genericCertificateIssueSchema = z
  .object({
    sourceType: certificateSourceTypeSchema,
    sourceReferenceId: optionalTextSchema(120),
    sourceLabel: optionalTextSchema(120),
    userId: uuidSchema.optional().nullable(),
    enrollmentId: uuidSchema.optional().nullable(),
    courseId: uuidSchema.optional().nullable(),
    academyQuizId: uuidSchema.optional().nullable(),
    examinationId: uuidSchema.optional().nullable(),
    recipientName: z.string().trim().min(2).max(150),
    recipientEmail: z
      .union([z.literal(''), emailSchema])
      .nullable()
      .optional()
      .transform((v) => (v === '' ? null : v)),
    recipientStudentCode: optionalTextSchema(50),
    templateId: uuidSchema.optional(),
    certificateTitle: z.string().trim().min(2).max(160).optional(),
    subjectTitle: z.string().trim().min(2).max(200),
    description: optionalTextSchema(1000),
    achievementDetails: optionalTextSchema(500),
    completedAt: z.iso.datetime().optional().nullable(),
    issuedAt: z.iso.datetime().optional().nullable(),
    idempotencyKey: z.string().trim().min(3).max(180).optional(),
    signatures: z.array(certificateSignaturePlacementSchema).optional(),
    metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  })
  .superRefine((val, ctx) => {
    if (val.signatures !== undefined) {
      validateSignatureSelections(val.signatures, ctx);
    }
  });

export type GenericCertificateIssueInput = z.infer<typeof genericCertificateIssueSchema>;

export const reissueCertificateSchema = z
  .object({
    reason: z.string().trim().min(3, 'Reissue reason must be at least 3 characters').max(500),
    templateId: uuidSchema.optional(),
    certificateTitle: z.string().trim().min(2).max(160).optional(),
    subjectTitle: z.string().trim().min(2).max(200).optional(),
    description: optionalTextSchema(1000),
    achievementDetails: optionalTextSchema(500),
    signatures: z.array(certificateSignaturePlacementSchema).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.signatures !== undefined) {
      validateSignatureSelections(val.signatures, ctx);
    }
  });

export type ReissueCertificateInput = z.infer<typeof reissueCertificateSchema>;

export const updateCertificateSettingsSchema = z.object({
  academyName: z.string().trim().min(2).max(160).optional(),
  academyTagline: z.string().trim().min(2).max(220).optional(),
  defaultTemplateId: uuidSchema.nullable().optional(),
  verificationNotice: z.string().trim().min(5).max(500).optional(),
  showQrOnCertificates: z.boolean().optional(),
  autoIssueOnCourseCompletion: z.boolean().optional(),
  autoIssueOnQuizCompletion: z.boolean().optional(),
});

export type UpdateCertificateSettingsInput = z.infer<typeof updateCertificateSettingsSchema>;

export const certificateStudentSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(30).default(15),
});

export type CertificateStudentSearchQuery = z.infer<typeof certificateStudentSearchQuerySchema>;

export const certificateAuditQuerySchema = paginationQuerySchema.extend({
  entityType: z.enum(['template', 'signature', 'certificate', 'settings']).optional(),
  certificateId: uuidSchema.optional(),
});

export type CertificateAuditQuery = z.infer<typeof certificateAuditQuerySchema>;

export const SOURCE_TYPE_LABELS: Record<CertificateSourceType, string> = {
  COURSE: 'Course',
  ACADEMY_QUIZ: 'Academy Quiz',
  COMPETITION: 'Competition',
  EXAM: 'Examination',
  EVENT: 'Event',
  WORKSHOP: 'Workshop',
  TRAINING: 'Training Program',
  MANUAL: 'Manual',
  CUSTOM: 'Custom',
};

// =============================================================================
// Quiz Certificate Generation & Bulk Issuance Validation
// =============================================================================

export const quizCertificateRecipientModeSchema = z.enum([
  'ALL_PARTICIPANTS',
  'RANKERS_ONLY',
  'SELECTED_RANKS',
  'INDIVIDUAL_PARTICIPANTS',
]);

export const quizCertificateFormatSchema = z.enum(['PDF', 'PNG', 'BOTH']);

export const quizCertificateCategorySchema = z.enum(['PARTICIPATION', 'RANK']);

export const quizCertificateTemplateAssignmentSchema = z.object({
  participationTemplateId: uuidSchema.nullable().optional(),
  rank1TemplateId: uuidSchema.nullable().optional(),
  rank2TemplateId: uuidSchema.nullable().optional(),
  rank3TemplateId: uuidSchema.nullable().optional(),
  otherRankTemplateId: uuidSchema.nullable().optional(),
  issueRankCertificatesToTopRankers: z.boolean().optional().default(true),
});

export const quizCertificateEligibleQuerySchema = z.object({
  mode: quizCertificateRecipientModeSchema.optional(),
  topN: z.coerce.number().int().min(1).max(1000).optional(),
  rankFrom: z.coerce.number().int().min(1).max(1000).optional(),
  rankTo: z.coerce.number().int().min(1).max(1000).optional(),
  ranks: z.string().trim().max(500).optional(),
  search: z.string().trim().max(100).optional(),
});

export type QuizCertificateEligibleQuery = z.infer<typeof quizCertificateEligibleQuerySchema>;

export const quizCertificateIssuanceRequestSchema = z
  .object({
    recipientMode: quizCertificateRecipientModeSchema,
    topN: z.number().int().min(1).max(1000).optional().nullable(),
    rankFrom: z.number().int().min(1).max(1000).optional().nullable(),
    rankTo: z.number().int().min(1).max(1000).optional().nullable(),
    selectedRanks: z.array(z.number().int().min(1).max(1000)).max(200).optional().default([]),
    selectedUserIds: z.array(uuidSchema).max(2000).optional().default([]),
    individualCategory: quizCertificateCategorySchema.optional().default('PARTICIPATION'),
    templates: quizCertificateTemplateAssignmentSchema,
    format: quizCertificateFormatSchema.default('BOTH'),
    sendEmail: z.boolean().default(true),
    showInStudentDashboard: z.boolean().default(true),
  })
  .superRefine((val, ctx) => {
    if (val.recipientMode === 'RANKERS_ONLY') {
      const hasTopN = typeof val.topN === 'number' && val.topN >= 1;
      const hasRange =
        typeof val.rankFrom === 'number' &&
        typeof val.rankTo === 'number' &&
        val.rankFrom >= 1 &&
        val.rankTo >= val.rankFrom;
      if (!hasTopN && !hasRange) {
        ctx.addIssue({
          code: 'custom',
          path: ['topN'],
          message: 'Specify a Top N limit or a valid rank range (from/to).',
        });
      }
    }
    if (val.recipientMode === 'SELECTED_RANKS' && val.selectedRanks.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['selectedRanks'],
        message: 'Select at least one rank.',
      });
    }
    if (val.recipientMode === 'INDIVIDUAL_PARTICIPANTS' && val.selectedUserIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['selectedUserIds'],
        message: 'Select at least one eligible participant.',
      });
    }
  });

export type QuizCertificateIssuanceRequestInput = z.infer<
  typeof quizCertificateIssuanceRequestSchema
>;

export const quizCertificateSamplePreviewSchema = z.object({
  templateId: uuidSchema,
  rank: z.number().int().min(1).max(1000).nullable().optional(),
  category: quizCertificateCategorySchema.default('PARTICIPATION'),
  format: z.enum(['pdf', 'png']).default('pdf'),
});

export type QuizCertificateSamplePreviewInput = z.infer<typeof quizCertificateSamplePreviewSchema>;

export const quizCertificateRetrySchema = z.object({
  scope: z.enum(['FAILED_GENERATIONS', 'FAILED_EMAILS', 'ALL_FAILED']).default('ALL_FAILED'),
  itemIds: z.array(uuidSchema).max(500).optional(),
});

export type QuizCertificateRetryInput = z.infer<typeof quizCertificateRetrySchema>;

export const quizCertificateBatchItemsQuerySchema = z.object({
  generationStatus: z.enum(['PENDING', 'PROCESSING', 'GENERATED', 'FAILED']).optional(),
  emailStatus: z.enum(['NOT_REQUESTED', 'PENDING', 'SENDING', 'SENT', 'FAILED']).optional(),
  search: z.string().trim().max(100).optional(),
});

export type QuizCertificateBatchItemsQuery = z.infer<typeof quizCertificateBatchItemsQuerySchema>;

export const quizIssuedCertificatesQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  category: quizCertificateCategorySchema.optional(),
});

export type QuizIssuedCertificatesQuery = z.infer<typeof quizIssuedCertificatesQuerySchema>;
