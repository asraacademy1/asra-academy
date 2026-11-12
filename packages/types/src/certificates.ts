import type { CourseProgressDto } from './student.js';

export type CertificateStatus = 'ISSUED' | 'REVOKED';

/**
 * Computed lifecycle state displayed in UI, previews, dynamic exports, and public verification.
 * Persists `REVOKED` in the PostgreSQL enum without a schema migration while clearly
 * distinguishing replaced credentials (`SUPERSEDED`) from disciplinary/error revocations (`REVOKED`).
 */
export type CertificateLifecycleStatus = 'ISSUED' | 'REVOKED' | 'SUPERSEDED';

export const CERTIFICATE_SOURCE_TYPES = [
  'COURSE',
  'ACADEMY_QUIZ',
  'COMPETITION',
  'EXAM',
  'EVENT',
  'WORKSHOP',
  'TRAINING',
  'MANUAL',
  'CUSTOM',
] as const;

export type CertificateSourceType = (typeof CERTIFICATE_SOURCE_TYPES)[number];

export const CERTIFICATE_TEMPLATE_STYLES = [
  'CLASSIC_INSTITUTIONAL',
  'MODERN_MINIMAL',
  'PREMIUM_ACHIEVEMENT',
] as const;

export type CertificateTemplateStyle = (typeof CERTIFICATE_TEMPLATE_STYLES)[number];

export interface CertificateTemplateConfigDto {
  accentColor: string;
  secondaryColor: string;
  showLogo: boolean;
  showSeal: boolean;
  showQrCode: boolean;
  showCompletionDate: boolean;
  showIssueDate: boolean;
  showCertificateNumber: boolean;
  showSourceLabel: boolean;
  footerNote?: string | null;
}

export interface CertificateSignatureDto {
  id: string;
  fullName: string;
  designation: string;
  department: string | null;
  storageProvider: string;
  storageKey: string;
  imageUrl: string | null;
  /** Safe inline preview data URL when serving from local dev storage without public HTTPS URL. */
  previewDataUrl?: string | null;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  hasTransparency: boolean;
  isActive: boolean;
  templateUsageCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CertificateTemplateSignatureDto {
  id: string;
  signatureId: string;
  sortOrder: number;
  positionLabel: string;
  showName: boolean;
  showDesignation: boolean;
  signature: CertificateSignatureDto;
}

export interface CertificateSignatureSnapshotDto {
  signatureId: string | null;
  fullName: string;
  designation: string;
  department?: string | null;
  positionLabel: string;
  sortOrder: number;
  showName: boolean;
  showDesignation: boolean;
  storageProvider?: string | null;
  storageKey?: string | null;
  imageUrl?: string | null;
  /** Rendered data URL when fetched for preview/verification without exposing private credentials. */
  previewDataUrl?: string | null;
  width?: number | null;
  height?: number | null;
  isFallback?: boolean;
}

export interface CertificateTemplateSnapshotDto {
  templateId: string | null;
  key: string;
  name: string;
  style: CertificateTemplateStyle;
  version: number;
  certificateTitle: string;
  subtitle?: string | null;
  bodyText: string;
  issuingAuthority: string;
  config: CertificateTemplateConfigDto;
}

export interface CertificateTemplateDto {
  id: string;
  key: string;
  name: string;
  style: CertificateTemplateStyle;
  description: string | null;
  defaultTitle: string;
  defaultSubtitle: string | null;
  defaultBodyText: string;
  issuingAuthority: string;
  config: CertificateTemplateConfigDto;
  version: number;
  isActive: boolean;
  isDefault: boolean;
  signatures: CertificateTemplateSignatureDto[];
  issuedCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CertificateSettingsDto {
  academyName: string;
  academyTagline: string;
  defaultTemplateId: string | null;
  verificationNotice: string;
  showQrOnCertificates: boolean;
  autoIssueOnCourseCompletion: boolean;
  autoIssueOnQuizCompletion: boolean;
  updatedAt: string;
}

export interface CertificateDto {
  id: string;
  certificateNumber: string;
  enrollmentId: string | null;
  userId: string | null;
  courseId: string | null;
  academyQuizId?: string | null;
  examinationId?: string | null;
  sourceType: CertificateSourceType;
  sourceReferenceId?: string | null;
  sourceLabel?: string | null;
  templateId?: string | null;
  recipientName: string;
  recipientEmail?: string | null;
  recipientStudentCode?: string | null;
  certificateTitle: string;
  courseTitle: string;
  description?: string | null;
  achievementDetails?: string | null;
  completedAt: string;
  issuedAt: string;
  status: CertificateStatus;
  lifecycleStatus?: CertificateLifecycleStatus;
  supersededByCertificateNumber?: string | null;
  revokedAt?: string | null;
  revokedReason?: string | null;
  metadata?: Record<string, unknown> | null;
  templateSnapshot?: CertificateTemplateSnapshotDto | null;
  signatureSnapshots?: CertificateSignatureSnapshotDto[] | null;
  reissuedFromId?: string | null;
  certificateCategory?: QuizCertificateCategory | null;
  quizRank?: number | null;
  issuedFormats?: ('PDF' | 'PNG')[];
  visibleInStudentDashboard?: boolean;
  verificationUrl: string;
  downloadUrl: string;
  pngDownloadUrl?: string;
}

export type CertificateEligibilityState = 'ELIGIBLE' | 'ALREADY_ISSUED' | 'INELIGIBLE';

export type CertificateIneligibilityCode =
  | 'NOT_ENROLLED'
  | 'ENROLLMENT_INACTIVE'
  | 'PROGRESS_INCOMPLETE'
  | 'EXAM_NOT_PASSED'
  | 'EXAM_PENDING_GRADING'
  | 'COURSE_NOT_COMPLETED'
  | 'QUIZ_NOT_COMPLETED'
  | 'QUIZ_NOT_PASSED';

export interface CertificateIneligibilityReason {
  code: CertificateIneligibilityCode;
  message: string;
}

export interface CertificateEligibilityResult {
  state: CertificateEligibilityState;
  eligible: boolean;
  courseId: string;
  courseTitle: string;
  enrollmentId?: string | null;
  completedAt?: string | null;
  certificate?: CertificateDto | null;
  reasons: CertificateIneligibilityReason[];
  progress?: CourseProgressDto | null;
}

export interface PublicCertificateVerificationDto {
  valid: boolean;
  certificateNumber: string;
  status: CertificateStatus;
  lifecycleStatus?: CertificateLifecycleStatus;
  supersededByCertificateNumber?: string | null;
  sourceType: CertificateSourceType;
  sourceLabel: string | null;
  certificateTitle: string;
  recipientName: string;
  courseTitle: string;
  description: string | null;
  achievementDetails: string | null;
  academyName: string;
  completedAt: string;
  issuedAt: string;
  revokedAt?: string | null;
  revokedReason?: string | null;
  signatories: { fullName: string; designation: string; department?: string | null }[];
  verifiedCount?: number;
}

export interface AdminCertificateListItem {
  id: string;
  certificateNumber: string;
  enrollmentId: string | null;
  userId: string | null;
  recipientName: string;
  studentEmail: string | null;
  recipientStudentCode: string | null;
  courseId: string | null;
  academyQuizId: string | null;
  examinationId: string | null;
  sourceType: CertificateSourceType;
  sourceReferenceId: string | null;
  sourceLabel: string | null;
  templateId: string | null;
  templateName: string | null;
  certificateTitle: string;
  courseTitle: string;
  description: string | null;
  achievementDetails: string | null;
  completedAt: string;
  issuedAt: string;
  status: CertificateStatus;
  lifecycleStatus?: CertificateLifecycleStatus;
  supersededByCertificateNumber?: string | null;
  revokedAt?: string | null;
  revokedReason?: string | null;
  issuedByName?: string | null;
  reissuedFromId?: string | null;
  signatureCount: number;
  templateSnapshot?: CertificateTemplateSnapshotDto | null;
  signatureSnapshots?: CertificateSignatureSnapshotDto[] | null;
  certificateCategory?: QuizCertificateCategory | null;
  quizRank?: number | null;
  issuedFormats?: ('PDF' | 'PNG')[];
  visibleInStudentDashboard?: boolean;
  verificationUrl: string;
  downloadUrl?: string;
  pngDownloadUrl?: string;
}

export interface CertificateOverviewStatsDto {
  totalIssued: number;
  totalRevoked: number;
  issuedThisMonth: number;
  activeTemplates: number;
  totalSignatures: number;
  activeSignatures: number;
  bySource: { sourceType: CertificateSourceType; count: number }[];
  coursesCount: number;
  academyQuizzesCount: number;
  competitionsCount: number;
  recentCertificates: AdminCertificateListItem[];
}

export interface CertificateStudentLookupDto {
  userId: string;
  fullName: string;
  email: string;
  studentCode: string | null;
  className: string | null;
  streamName: string | null;
  status: string;
}

export interface CertificateSourceOptionDto {
  id: string;
  title: string;
  subtitle?: string | null;
}

export interface CertificateAuditLogItemDto {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  certificateId: string | null;
  actor: { userId: string; fullName: string } | null;
  data: Record<string, unknown> | null;
  createdAt: string;
}

// =============================================================================
// Quiz Certificate Generation & Bulk Issuance DTOs
// =============================================================================

export type QuizCertificateCategory = 'PARTICIPATION' | 'RANK';

export type QuizCertificateRecipientMode =
  'ALL_PARTICIPANTS' | 'RANKERS_ONLY' | 'SELECTED_RANKS' | 'INDIVIDUAL_PARTICIPANTS';

export type QuizCertificateFormat = 'PDF' | 'PNG' | 'BOTH';

export type QuizCertificateBatchStatus =
  'PENDING' | 'PROCESSING' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS' | 'FAILED';

export type QuizCertificateGenerationStatus = 'PENDING' | 'PROCESSING' | 'GENERATED' | 'FAILED';

export type QuizCertificateEmailStatus =
  'NOT_REQUESTED' | 'PENDING' | 'SENDING' | 'SENT' | 'FAILED';

export interface QuizCertificateTemplateAssignmentDto {
  participationTemplateId?: string | null;
  rank1TemplateId?: string | null;
  rank2TemplateId?: string | null;
  rank3TemplateId?: string | null;
  otherRankTemplateId?: string | null;
  issueRankCertificatesToTopRankers?: boolean;
}

export interface QuizCertificateBatchSummaryDto {
  id: string;
  quizId: string;
  recipientMode: QuizCertificateRecipientMode;
  format: QuizCertificateFormat;
  sendEmail: boolean;
  showInStudentDashboard: boolean;
  status: QuizCertificateBatchStatus;
  totalRecipients: number;
  excludedDuplicates: number;
  totalQueued: number;
  generatedCount: number;
  generationFailedCount: number;
  emailsSentCount: number;
  emailsFailedCount: number;
  pendingGenerationCount: number;
  pendingEmailCount: number;
  completionPercent: number;
  initiatedByName: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuizCertificateSummaryDto {
  quizId: string;
  quizTitle: string;
  quizSlug: string;
  status: 'DRAFT' | 'PUBLISHED' | 'CLOSED';
  phase: 'DRAFT' | 'UPCOMING' | 'LIVE' | 'ENDED' | 'CLOSED';
  isCompleted: boolean;
  completionStatusLabel: string;
  pendingFinalization: number;
  totalEligibleParticipants: number;
  totalEligibleRankers: number;
  alreadyIssuedCount: number;
  issuedParticipationCount: number;
  issuedRankCount: number;
  pendingIssuanceCount: number;
  inFlightCount: number;
  activeValidTemplatesCount: number;
  latestBatch: QuizCertificateBatchSummaryDto | null;
}

export interface QuizEligibleParticipantDto {
  userId: string;
  fullName: string;
  email: string;
  studentCode: string | null;
  attemptId: string;
  attemptNumber: number;
  score: number;
  maxScore: number;
  percent: number;
  timeTakenSeconds: number;
  submittedAt: string;
  rank: number;
  alreadyIssuedParticipation: boolean;
  participationCertificateNumber: string | null;
  alreadyIssuedRank: boolean;
  rankCertificateNumber: string | null;
  inFlightParticipation: boolean;
  inFlightRank: boolean;
}

export interface QuizEligibleParticipantsResponseDto {
  quizId: string;
  isCompleted: boolean;
  pendingFinalization: number;
  totalEligibleParticipants: number;
  availableRanks: number[];
  items: QuizEligibleParticipantDto[];
}

export interface QuizCertificatePreviewRecipientDto {
  userId: string;
  fullName: string;
  email: string;
  attemptId: string;
  rank: number | null;
  score: number;
  maxScore: number;
  percent: number;
  category: QuizCertificateCategory;
  templateId: string;
  templateName: string;
  excludedAsDuplicate: boolean;
  duplicateReason: string | null;
  existingCertificateNumber: string | null;
}

export interface QuizCertificatePreviewResponseDto {
  quiz: { id: string; title: string; slug: string; completedAt: string };
  recipientMode: QuizCertificateRecipientMode;
  format: QuizCertificateFormat;
  sendEmail: boolean;
  showInStudentDashboard: boolean;
  totalUniqueRecipients: number;
  toGenerateCount: number;
  alreadyIssuedExcludedCount: number;
  participationTemplateName: string | null;
  rankTemplateAssignments: {
    label: string;
    templateId: string;
    templateName: string;
  }[];
  recipients: QuizCertificatePreviewRecipientDto[];
  emailPreview: {
    subject: string;
    text: string;
    html: string;
  };
}

export interface QuizCertificateIssuanceItemDto {
  id: string;
  batchId: string;
  userId: string;
  recipientName: string;
  recipientEmail: string;
  attemptId: string;
  templateId: string;
  templateName: string;
  category: QuizCertificateCategory;
  rank: number | null;
  score: number | null;
  percent: number | null;
  certificateId: string | null;
  certificateNumber: string | null;
  pdfReference: string | null;
  pngReference: string | null;
  generationStatus: QuizCertificateGenerationStatus;
  generationAttempts: number;
  generationError: string | null;
  emailStatus: QuizCertificateEmailStatus;
  emailAttempts: number;
  emailError: string | null;
  emailSentAt: string | null;
  issuedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuizCertificateBatchDetailDto {
  batch: QuizCertificateBatchSummaryDto;
  items: QuizCertificateIssuanceItemDto[];
  totalItems: number;
}

export interface QuizIssuedCertificateItemDto extends AdminCertificateListItem {
  quizAttemptId: string | null;
  emailStatus: QuizCertificateEmailStatus | null;
  emailSentAt: string | null;
}
