import { PERMISSIONS } from '@asra/types';
import {
  answerSaveSchema,
  attemptSubmitSchema,
  paginationQuerySchema,
  studentCatalogQuerySchema,
  studentExamListQuerySchema,
  studentEnrollmentListQuerySchema,
  studentLessonListQuerySchema,
  studentLiveClassQuerySchema,
  studentProfileUpdateSchema,
  studentSubmissionSchema,
  videoProgressSchema,
} from '@asra/validation';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission, requireRole } from '../../middleware/authorize.js';
import { assessmentRateLimit } from '../../middleware/rate-limit.js';
import { validateRequest } from '../../middleware/validate-request.js';
import { idParamsSchema } from '../../validators/common.validators.js';
import { studentAssessmentController as a } from '../assessments/assessments.controller.js';
import { studentAcademyQuizzesRouter } from '../academy-quizzes/student.routes.js';
import { studentCertificatesRouter } from '../certificates/certificates.routes.js';
import { studentPaymentsRouter } from '../payments/payments.routes.js';
import { studentController as c } from './student.controller.js';

/**
 * `/api/v1/student/*` — the student portal (PHASE 07, docs/STUDENT-LMS.md §6).
 *
 * Every request: `authenticate` → `requireRole('STUDENT')` → `no-store`. Course content routes
 * also require `content.view_enrolled` and the service checks the per-course enrolment policy;
 * profile routes require `profile.manage_own`. Data is always scoped to `req.auth.userId`.
 */
export const studentRouter = Router();

studentRouter.use(authenticate, requireRole('STUDENT'), (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const learn = requirePermission(PERMISSIONS.CONTENT_VIEW_ENROLLED);
const own = requirePermission(PERMISSIONS.PROFILE_MANAGE_OWN);
const byId = validateRequest({ params: idParamsSchema });
const paged = validateRequest({ query: paginationQuerySchema });

const r = studentRouter;

r.get('/dashboard', learn, c.dashboard);
r.get('/features', c.features);

r.get('/courses', learn, paged, c.courses);
r.get(
  '/enrollments',
  learn,
  validateRequest({ query: studentEnrollmentListQuerySchema }),
  c.enrollments,
);
r.get('/catalog', learn, validateRequest({ query: studentCatalogQuerySchema }), c.catalog);
r.post('/courses/:id/enroll', learn, byId, c.enroll);
r.get('/courses/:id', learn, byId, c.courseOverview);
r.get('/courses/:id/curriculum', learn, byId, c.curriculum);
r.get('/courses/:id/progress', learn, byId, c.courseProgress);

r.get('/lessons', learn, validateRequest({ query: studentLessonListQuerySchema }), c.lessons);
r.get('/lessons/:id', learn, byId, c.lesson);
r.get('/lessons/:id/resources', learn, byId, c.lessonResources);
r.post('/lessons/:id/activity', learn, byId, c.recordActivity);
r.post('/lessons/:id/complete', learn, byId, c.complete);
r.delete('/lessons/:id/complete', learn, byId, c.reopen);
r.put(
  '/lessons/:id/progress',
  learn,
  validateRequest({ params: idParamsSchema, body: videoProgressSchema }),
  c.videoProgress,
);

// Assignments, results and live classes (PHASE 08, docs/FACULTY-PORTAL.md §5–6).
r.get('/lessons/:id/assignment', learn, byId, c.assignment);
r.post(
  '/lessons/:id/submission',
  learn,
  validateRequest({ params: idParamsSchema, body: studentSubmissionSchema }),
  c.submit,
);
r.get('/results', learn, paged, c.results);
r.get(
  '/live-classes',
  learn,
  validateRequest({ query: studentLiveClassQuerySchema }),
  c.liveClasses,
);

// Quizzes, examinations and attempts (PHASE 09, docs/ASSESSMENTS.md §9). The server decides
// every time-based outcome; bodies are strict, so no time, score or correctness can be posted.
const startLimit = assessmentRateLimit('attemptStart');
const answerLimit = assessmentRateLimit('answerSave');
const submitLimit = assessmentRateLimit('attemptSubmit');
const answerParams = z.object({ id: z.uuid(), questionId: z.uuid() });

r.get('/lessons/:id/quiz', learn, byId, a.quiz);
r.post(
  '/lessons/:id/quiz/attempts',
  learn,
  startLimit,
  validateRequest({ params: idParamsSchema, body: attemptSubmitSchema.optional() }),
  a.startQuiz,
);
r.get('/exams', learn, validateRequest({ query: studentExamListQuerySchema }), a.exams);
r.get('/exams/:id', learn, byId, a.exam);
r.post(
  '/exams/:id/attempts',
  learn,
  startLimit,
  validateRequest({ params: idParamsSchema, body: attemptSubmitSchema.optional() }),
  a.startExam,
);
r.get('/attempts/:id', learn, byId, a.attempt);
r.put(
  '/attempts/:id/answers/:questionId',
  learn,
  answerLimit,
  validateRequest({ params: answerParams, body: answerSaveSchema }),
  a.saveAnswer,
);
r.post(
  '/attempts/:id/submit',
  learn,
  submitLimit,
  validateRequest({ params: idParamsSchema, body: attemptSubmitSchema.optional() }),
  a.submit,
);
r.get('/assessment-results', learn, paged, a.results);

r.get('/history', learn, paged, c.history);

r.get('/profile', own, c.profile);
r.patch('/profile', own, validateRequest({ body: studentProfileUpdateSchema }), c.updateProfile);

// Checkout, orders, payment history and receipts (PHASE 10, docs/PAYMENTS.md §14). Each route
// requires `payments.make_own`; every order is scoped to `req.auth.userId`.
r.use(studentPaymentsRouter);

// Certificates & eligibility (PHASE 13, docs/CERTIFICATE-SYSTEM.md).
r.use(studentCertificatesRouter);

// Academy Quizzes (standalone competitions; no enrolment): `academy_quizzes.participate`.
r.use(studentAcademyQuizzesRouter);
