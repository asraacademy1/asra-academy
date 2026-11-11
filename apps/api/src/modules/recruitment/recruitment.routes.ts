import express, { Router } from 'express';
import { z } from 'zod';
import { PERMISSIONS } from '@asra/types';
import {
  adminCreateJobSchema,
  adminUpdateJobSchema,
  adminJobQuerySchema,
  publicJobQuerySchema,
  publicSubmitApplicationSchema,
  adminApplicationQuerySchema,
  adminChangeApplicationStatusSchema,
  adminScheduleInterviewSchema,
  adminRescheduleInterviewSchema,
  adminCancelInterviewSchema,
  adminAddNoteSchema,
  adminSendEmailSchema,
  uuidSchema,
} from '@asra/validation';
import { requirePermission } from '../../middleware/authorize.js';
import { recruitmentRateLimit } from '../../middleware/rate-limit.js';
import { validateRequest } from '../../middleware/validate-request.js';
import { recruitmentController } from './recruitment.controller.js';

// =============================================================================
// PUBLIC CAREERS ROUTER (`/api/v1/careers`)
// =============================================================================

export const publicCareersRouter = Router();

publicCareersRouter.get(
  ['/', '/jobs'],
  validateRequest({ query: publicJobQuerySchema }),
  recruitmentController.listPublicJobs,
);

publicCareersRouter.get(
  ['/categories', '/jobs/categories'],
  recruitmentController.getPublicCategories,
);

publicCareersRouter.get(
  ['/:jobId', '/jobs/:jobId'],
  validateRequest({ params: z.object({ jobId: z.string().trim().min(1) }) }),
  recruitmentController.getPublicJob,
);

publicCareersRouter.post(
  ['/:jobId/apply', '/jobs/:jobId/apply'],
  recruitmentRateLimit('apply'),
  validateRequest({
    params: z.object({ jobId: z.string().trim().min(1) }),
    body: publicSubmitApplicationSchema,
  }),
  recruitmentController.submitApplication,
);

// Route-level body parsing with higher limit (10MB) for resume file uploads
publicCareersRouter.post(
  '/upload-resume',
  recruitmentRateLimit('upload'),
  express.json({ limit: '10mb' }),
  express.raw({ limit: '10mb', type: ['application/pdf', 'application/octet-stream'] }),
  recruitmentController.uploadResume,
);

// =============================================================================
// ADMIN RECRUITMENT ROUTER (`/api/v1/admin/recruitment`)
// =============================================================================

export const recruitmentAdminRouter = Router();

const manageRecruitment = requirePermission(PERMISSIONS.RECRUITMENT_MANAGE);

// Overview KPIs
recruitmentAdminRouter.get('/recruitment/stats', manageRecruitment, recruitmentController.getStats);

// Jobs CRUD
recruitmentAdminRouter.get(
  '/recruitment/jobs',
  manageRecruitment,
  validateRequest({ query: adminJobQuerySchema }),
  recruitmentController.listAdminJobs,
);

recruitmentAdminRouter.post(
  '/recruitment/jobs',
  manageRecruitment,
  validateRequest({ body: adminCreateJobSchema }),
  recruitmentController.createJob,
);

recruitmentAdminRouter.get(
  '/recruitment/jobs/:id',
  manageRecruitment,
  validateRequest({ params: z.object({ id: uuidSchema }) }),
  recruitmentController.getAdminJob,
);

recruitmentAdminRouter.put(
  '/recruitment/jobs/:id',
  manageRecruitment,
  validateRequest({
    params: z.object({ id: uuidSchema }),
    body: adminUpdateJobSchema,
  }),
  recruitmentController.updateJob,
);

recruitmentAdminRouter.post(
  '/recruitment/jobs/:id/publish',
  manageRecruitment,
  validateRequest({ params: z.object({ id: uuidSchema }) }),
  recruitmentController.publishJob,
);

recruitmentAdminRouter.post(
  '/recruitment/jobs/:id/unpublish',
  manageRecruitment,
  validateRequest({ params: z.object({ id: uuidSchema }) }),
  recruitmentController.unpublishJob,
);

recruitmentAdminRouter.post(
  '/recruitment/jobs/:id/archive',
  manageRecruitment,
  validateRequest({ params: z.object({ id: uuidSchema }) }),
  recruitmentController.archiveJob,
);

recruitmentAdminRouter.delete(
  '/recruitment/jobs/:id',
  manageRecruitment,
  validateRequest({ params: z.object({ id: uuidSchema }) }),
  recruitmentController.deleteJob,
);

// Applications
recruitmentAdminRouter.get(
  '/recruitment/applications',
  manageRecruitment,
  validateRequest({ query: adminApplicationQuerySchema }),
  recruitmentController.listAdminApplications,
);

recruitmentAdminRouter.get(
  '/recruitment/applications/:id',
  manageRecruitment,
  validateRequest({ params: z.object({ id: uuidSchema }) }),
  recruitmentController.getAdminApplication,
);

recruitmentAdminRouter.post(
  '/recruitment/applications/:id/status',
  manageRecruitment,
  validateRequest({
    params: z.object({ id: uuidSchema }),
    body: adminChangeApplicationStatusSchema,
  }),
  recruitmentController.updateApplicationStatus,
);

recruitmentAdminRouter.post(
  '/recruitment/applications/:id/interviews',
  manageRecruitment,
  validateRequest({
    params: z.object({ id: uuidSchema }),
    body: adminScheduleInterviewSchema,
  }),
  recruitmentController.scheduleInterview,
);

recruitmentAdminRouter.patch(
  '/recruitment/interviews/:interviewId',
  manageRecruitment,
  validateRequest({
    params: z.object({ interviewId: uuidSchema }),
    body: adminRescheduleInterviewSchema,
  }),
  recruitmentController.rescheduleInterview,
);

recruitmentAdminRouter.post(
  '/recruitment/interviews/:interviewId/cancel',
  manageRecruitment,
  validateRequest({
    params: z.object({ interviewId: uuidSchema }),
    body: adminCancelInterviewSchema,
  }),
  recruitmentController.cancelInterview,
);

recruitmentAdminRouter.post(
  '/recruitment/applications/:id/notes',
  manageRecruitment,
  validateRequest({
    params: z.object({ id: uuidSchema }),
    body: adminAddNoteSchema,
  }),
  recruitmentController.addNote,
);

recruitmentAdminRouter.post(
  '/recruitment/applications/:id/email',
  manageRecruitment,
  validateRequest({
    params: z.object({ id: uuidSchema }),
    body: adminSendEmailSchema,
  }),
  recruitmentController.sendEmail,
);

recruitmentAdminRouter.get(
  '/recruitment/applications/:id/resume',
  manageRecruitment,
  validateRequest({
    params: z.object({ id: uuidSchema }),
    query: z.object({
      disposition: z.enum(['inline', 'attachment']).optional(),
    }),
  }),
  recruitmentController.downloadResume,
);
