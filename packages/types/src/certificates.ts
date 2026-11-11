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
