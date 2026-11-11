import { PERMISSIONS } from '@asra/types';
import {
  adminCertificateQuerySchema,
  adminRevokeCertificateSchema,
  certificateAuditQuerySchema,
  certificateDownloadQuerySchema,
  certificateIdParamSchema,
  certificateSignatureQuerySchema,
  certificateStudentSearchQuerySchema,
  certificateVerifyParamsSchema,
  genericCertificateIssueSchema,
  manualCertificateIssueSchema,
  reissueCertificateSchema,
  studentCertificateQuerySchema,
  updateCertificateSettingsSchema,
  updateCertificateTemplateSchema,
} from '@asra/validation';
import { Router } from 'express';
import { requireAnyPermission, requirePermission } from '../../middleware/authorize.js';
import { certificateRateLimit } from '../../middleware/rate-limit.js';
import { validateRequest } from '../../middleware/validate-request.js';
import { idParamsSchema } from '../../validators/common.validators.js';
import { certificatesController as c } from './certificates.controller.js';

/**
 * Public routes: `/api/v1/certificates/*`
 */
export const publicCertificatesRouter = Router();

publicCertificatesRouter.get(
  '/verify/:certificateNumber',
  certificateRateLimit('verify'),
  validateRequest({ params: certificateVerifyParamsSchema }),
  c.verifyCertificate,
);

/**
 * Student portal routes: to be mounted on `/api/v1/student`
 * Authentication and role check (STUDENT) are already applied on `/student`.
 */
export const studentCertificatesRouter = Router();

const learn = requirePermission(PERMISSIONS.CONTENT_VIEW_ENROLLED);
const quizParticipate = requirePermission(PERMISSIONS.ACADEMY_QUIZZES_PARTICIPATE);
const byId = validateRequest({ params: idParamsSchema });
const byIdWithFormat = validateRequest({
  params: idParamsSchema,
  query: certificateDownloadQuerySchema,
});
const studentPaged = validateRequest({ query: studentCertificateQuerySchema });

studentCertificatesRouter.get('/certificates', learn, studentPaged, c.getStudentCertificates);
studentCertificatesRouter.get('/certificates/:id', learn, byId, c.getStudentCertificate);
studentCertificatesRouter.get(
  '/certificates/:id/download',
  learn,
  byIdWithFormat,
  c.downloadStudentCertificate,
);
studentCertificatesRouter.get(
  '/certificates/:id/download/pdf',
  learn,
  byId,
  c.downloadStudentCertificatePdf,
);
studentCertificatesRouter.get(
  '/certificates/:id/download/png',
  learn,
  byId,
  c.downloadStudentCertificatePng,
);
studentCertificatesRouter.get(
  '/courses/:id/certificate/eligibility',
  learn,
  byId,
  c.checkCourseEligibility,
);
studentCertificatesRouter.post('/courses/:id/certificate', learn, byId, c.claimCertificate);
studentCertificatesRouter.post(
  '/academy-quizzes/:id/certificate',
  quizParticipate,
  byId,
  c.claimAcademyQuizCertificate,
);

/**
 * Admin portal routes: to be mounted on `/api/v1/admin`
 * Authentication is already applied on `/admin`.
 */
export const certificatesAdminRouter = Router();

const canView = requireAnyPermission(
  PERMISSIONS.CERTIFICATES_VIEW,
  PERMISSIONS.CERTIFICATES_MANAGE,
  PERMISSIONS.CERTIFICATES_TEMPLATES_MANAGE,
  PERMISSIONS.CERTIFICATES_SIGNATURES_MANAGE,
  PERMISSIONS.CERTIFICATES_ISSUE,
  PERMISSIONS.CERTIFICATES_REVOKE,
);
const canManageTemplates = requireAnyPermission(
  PERMISSIONS.CERTIFICATES_TEMPLATES_MANAGE,
  PERMISSIONS.CERTIFICATES_MANAGE,
);
const canManageSignatures = requireAnyPermission(
  PERMISSIONS.CERTIFICATES_SIGNATURES_MANAGE,
  PERMISSIONS.CERTIFICATES_MANAGE,
);
const canIssue = requireAnyPermission(
  PERMISSIONS.CERTIFICATES_ISSUE,
  PERMISSIONS.CERTIFICATES_MANAGE,
);
const canRevoke = requireAnyPermission(
  PERMISSIONS.CERTIFICATES_REVOKE,
  PERMISSIONS.CERTIFICATES_MANAGE,
);
const canManageGlobal = requirePermission(PERMISSIONS.CERTIFICATES_MANAGE);

// --- Overview, Settings, Audit & Lookup ---
certificatesAdminRouter.get('/certificates/overview', canView, c.getOverview);
certificatesAdminRouter.get('/certificates/settings', canView, c.getSettings);
certificatesAdminRouter.patch(
  '/certificates/settings',
  canManageGlobal,
  validateRequest({ body: updateCertificateSettingsSchema }),
  c.updateSettings,
);
certificatesAdminRouter.get(
  '/certificates/audit-logs',
  canView,
  validateRequest({ query: certificateAuditQuerySchema }),
  c.listAuditLogs,
);
certificatesAdminRouter.get(
  '/certificates/students/search',
  canIssue,
  validateRequest({ query: certificateStudentSearchQuerySchema }),
  c.searchStudents,
);
certificatesAdminRouter.get('/certificates/sources', canIssue, c.listSourceOptions);

// --- Templates ---
certificatesAdminRouter.get('/certificates/templates', canView, c.listTemplates);
certificatesAdminRouter.get(
  '/certificates/templates/:id',
  canView,
  validateRequest({ params: certificateIdParamSchema }),
  c.getTemplate,
);
certificatesAdminRouter.patch(
  '/certificates/templates/:id',
  canManageTemplates,
  validateRequest({ params: certificateIdParamSchema, body: updateCertificateTemplateSchema }),
  c.updateTemplate,
);
certificatesAdminRouter.get(
  '/certificates/templates/:id/preview',
  canView,
  validateRequest({ params: certificateIdParamSchema, query: certificateDownloadQuerySchema }),
  c.previewTemplatePdf,
);
certificatesAdminRouter.get(
  '/certificates/templates/:id/preview/png',
  canView,
  validateRequest({ params: certificateIdParamSchema }),
  c.previewTemplatePng,
);

// --- Digital Signatures ---
certificatesAdminRouter.get(
  '/certificates/signatures',
  canView,
  validateRequest({ query: certificateSignatureQuerySchema }),
  c.listSignatures,
);
certificatesAdminRouter.get('/certificates/signatures/active', canView, c.listActiveSignatures);
certificatesAdminRouter.get(
  '/certificates/signatures/:id',
  canView,
  validateRequest({ params: certificateIdParamSchema }),
  c.getSignature,
);
certificatesAdminRouter.post('/certificates/signatures', canManageSignatures, c.createSignature);
certificatesAdminRouter.patch(
  '/certificates/signatures/:id',
  canManageSignatures,
  validateRequest({ params: certificateIdParamSchema }),
  c.updateSignature,
);

// --- Manual & Generic Issuance ---
certificatesAdminRouter.post(
  '/certificates/manual',
  canIssue,
  validateRequest({ body: manualCertificateIssueSchema }),
  c.issueManualCertificate,
);
certificatesAdminRouter.post(
  '/certificates/issue',
  canIssue,
  validateRequest({ body: genericCertificateIssueSchema }),
  c.issueGenericCertificate,
);

// --- Issued Certificates List, Detail, Download, Reissue & Revoke ---
certificatesAdminRouter.get(
  '/certificates',
  canView,
  validateRequest({ query: adminCertificateQuerySchema }),
  c.listAdminCertificates,
);
certificatesAdminRouter.get(
  '/certificates/:id',
  canView,
  validateRequest({ params: certificateIdParamSchema }),
  c.getAdminCertificate,
);
certificatesAdminRouter.get(
  '/certificates/:id/download',
  canView,
  validateRequest({ params: certificateIdParamSchema, query: certificateDownloadQuerySchema }),
  c.downloadAdminCertificate,
);
certificatesAdminRouter.get(
  '/certificates/:id/download/pdf',
  canView,
  validateRequest({ params: certificateIdParamSchema }),
  c.downloadAdminCertificatePdf,
);
certificatesAdminRouter.get(
  '/certificates/:id/download/png',
  canView,
  validateRequest({ params: certificateIdParamSchema }),
  c.downloadAdminCertificatePng,
);
certificatesAdminRouter.post(
  '/certificates/:id/reissue',
  canIssue,
  validateRequest({ params: certificateIdParamSchema, body: reissueCertificateSchema }),
  c.reissueCertificate,
);
certificatesAdminRouter.post(
  '/certificates/:id/revoke',
  canRevoke,
  validateRequest({ params: certificateIdParamSchema, body: adminRevokeCertificateSchema }),
  c.revokeCertificate,
);
