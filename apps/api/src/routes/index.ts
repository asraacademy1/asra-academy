import { PERMISSIONS } from '@asra/types';
import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { requireAnyPermission } from '../middleware/authorize.js';
import { assessmentMediaRouter } from '../modules/assessments/media/media.routes.js';
import {
  announcementsAdminRouter,
  publicAnnouncementsRouter,
} from '../modules/announcements/announcements.routes.js';
import { academicsAdminRouter } from '../modules/academics/academics.routes.js';
import { academyQuizzesAdminRouter } from '../modules/academy-quizzes/academy-quizzes.routes.js';
import {
  publicParticipateRouter,
  publicQuizzesSitemapHandler,
} from '../modules/academy-quizzes/participate.routes.js';
import { adminPortalRouter } from '../modules/admin/admin.routes.js';
import {
  certificatesAdminRouter,
  publicCertificatesRouter,
} from '../modules/certificates/certificates.routes.js';
import {
  coursesAdminRouter,
  publicCoursesRouter,
  publicSitemapRouter,
} from '../modules/courses/courses.routes.js';
import { curriculumAdminRouter } from '../modules/curriculum/curriculum.routes.js';
import { enrollmentsAdminRouter } from '../modules/enrollments/enrollments.routes.js';
import { facultyRouter } from '../modules/faculty/faculty.routes.js';
import { liveClassesAdminRouter } from '../modules/live-classes/live-classes.routes.js';
import { notificationsRouter } from '../modules/notifications/notifications.routes.js';
import { paymentsAdminRouter } from '../modules/payments/payments.routes.js';
import {
  publicCareersRouter,
  recruitmentAdminRouter,
} from '../modules/recruitment/recruitment.routes.js';
import { studentRouter } from '../modules/student/student.routes.js';
import { authRouter } from './auth.routes.js';
import { healthRouter } from './health.routes.js';

/** Root router for `/api/v1`. Business modules register their routers here. */
export const apiRouter = Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/auth', authRouter);

/** Public, read-only catalogue (published courses only). */
apiRouter.use('/courses', publicCoursesRouter);
/** Public course URLs for the website sitemap (PHASE 14). */
apiRouter.use('/sitemap', publicSitemapRouter);
apiRouter.get('/sitemap/academy-quizzes', publicQuizzesSitemapHandler);

/** Public Participate discovery & quiz registration. */
apiRouter.use('/participate', publicParticipateRouter);

/** Public certificate verification (PHASE 13). */
apiRouter.use('/certificates', publicCertificatesRouter);

/** Public careers & job applications (PHASE 16). */
apiRouter.use('/careers', publicCareersRouter);

/** Public active announcements & popups (eligible published campaigns only). */
apiRouter.use('/announcements', publicAnnouncementsRouter);

/**
 * Administration (PHASE 06). Every request is authenticated here; each route then requires its
 * own permission (`academic_structure.manage`, `courses.manage` or `content.manage`), and the
 * services apply resource-level policies. Responses are never cached.
 */
const adminRouter = Router();
adminRouter.use(authenticate, (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
adminRouter.use(academicsAdminRouter);
adminRouter.use(coursesAdminRouter);
adminRouter.use(curriculumAdminRouter);
adminRouter.use(enrollmentsAdminRouter);
// Orders, payments, refunds and revenue (PHASE 10): `payments.view` / `payments.refund`.
adminRouter.use(paymentsAdminRouter);
// Live classes of any course (PHASE 11): `live_classes.manage`.
adminRouter.use(liveClassesAdminRouter);
// Dashboard, analytics, users & roles, audit logs and operational lists (PHASE 12).
adminRouter.use(adminPortalRouter);
// Certificates management (PHASE 13): `certificates.view` / `certificates.manage`.
adminRouter.use(certificatesAdminRouter);
// Recruitment & Careers management (PHASE 16): `recruitment.manage`.
adminRouter.use(recruitmentAdminRouter);
// Academy Quizzes administration (standalone quizzes): `academy_quizzes.manage` on every route.
adminRouter.use(academyQuizzesAdminRouter);
// Website announcements administration: `announcements.manage` on every route.
adminRouter.use(announcementsAdminRouter);
// Shared admin image upload (Cloudinary media ledger): quiz or announcement managers.
adminRouter.use(
  assessmentMediaRouter(
    requireAnyPermission(PERMISSIONS.ACADEMY_QUIZZES_MANAGE, PERMISSIONS.ANNOUNCEMENTS_MANAGE),
  ),
);
apiRouter.use('/admin', adminRouter);

/** In-app notifications of the signed-in user, any role (PHASE 11). */
apiRouter.use('/notifications', notificationsRouter);

/**
 * Student portal (PHASE 07): authenticated STUDENT accounts only; every course-content endpoint
 * also checks the per-course enrolment policy. See modules/student/student.routes.ts.
 */
apiRouter.use('/student', studentRouter);

/**
 * Faculty portal (PHASE 08): authenticated FACULTY accounts only; every course endpoint also
 * checks the faculty member's course assignment. See modules/faculty/faculty.routes.ts.
 */
apiRouter.use('/faculty', facultyRouter);
