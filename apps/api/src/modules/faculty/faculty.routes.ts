import { PERMISSIONS } from '@asra/types';
import {
  answerGradeSchema,
  assessmentTransitionSchema,
  assignmentCreateSchema,
  assignmentSettingsSchema,
  facultyAssignmentListQuerySchema,
  attemptListQuerySchema,
  examCreateSchema,
  examUpdateSchema,
  facultyCourseListQuerySchema,
  facultyExamListQuerySchema,
  facultyLessonListQuerySchema,
  facultyProfileUpdateSchema,
  facultyQuizListQuerySchema,
  facultyStudentListQuerySchema,
  gradeSubmissionSchema,
  liveClassCreateSchema,
  liveClassListQuerySchema,
  liveClassRecordingSchema,
  liveClassUpdateSchema,
  questionInputSchema,
  questionOrderSchema,
  quizCreateSchema,
  quizSettingsSchema,
  submissionListQuerySchema,
} from '@asra/validation';
import { Router, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission, requireRole } from '../../middleware/authorize.js';
import { validateRequest } from '../../middleware/validate-request.js';
import { idParamsSchema } from '../../validators/common.validators.js';
import { facultyAssessmentController as a } from '../assessments/assessments.controller.js';
import { assessmentMediaRouter } from '../assessments/media/media.routes.js';
import { curriculumFacultyRouter } from '../curriculum/curriculum.routes.js';
import { facultyController as c } from './faculty.controller.js';

/**
 * `/api/v1/faculty/*` — the faculty portal (PHASE 08, docs/FACULTY-PORTAL.md §4).
 *
 * Every request: `authenticate` → `requireRole('FACULTY')` → `no-store`. Each route then requires
 * its permission, and the services check the per-course assignment (`CourseInstructor`) for the
 * course resolved from the DATABASE. Holding a faculty profile grants nothing by itself, and no
 * route here changes roles, assignments, enrolments, payments or course publication.
 */
export const facultyRouter = Router();

facultyRouter.use(authenticate, requireRole('FACULTY'), (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const content = requirePermission(PERMISSIONS.CONTENT_MANAGE_ASSIGNED);
const students = requirePermission(PERMISSIONS.STUDENTS_VIEW_ASSIGNED);
const grading = requirePermission(PERMISSIONS.SUBMISSIONS_GRADE_ASSIGNED);
const classes = requirePermission(PERMISSIONS.LIVE_CLASSES_MANAGE_ASSIGNED);
const own = requirePermission(PERMISSIONS.PROFILE_MANAGE_OWN);
const byId = validateRequest({ params: idParamsSchema });
const withBody = (body: ZodType): RequestHandler =>
  validateRequest({ params: idParamsSchema, body });
const withQuery = (query: ZodType): RequestHandler => validateRequest({ query });
const withIdQuery = (query: ZodType): RequestHandler =>
  validateRequest({ params: idParamsSchema, query });

const r = facultyRouter;

r.get('/dashboard', content, c.dashboard);
r.get('/features', c.features);

r.get('/courses', content, withQuery(facultyCourseListQuerySchema), c.courses);
r.get('/courses/:id', content, byId, c.course);
r.get('/courses/:id/performance', students, byId, c.performance);
r.get('/students', students, withQuery(facultyStudentListQuerySchema), c.students);
r.get('/lessons', content, withQuery(facultyLessonListQuerySchema), c.lessons);

// Curriculum: same routes and service as /admin, limited to assigned courses by the service.
r.use(curriculumFacultyRouter);

// Question/option images (shared with administration). Uploading needs content.manage_assigned;
// attaching an image is authorized by the question save (assigned course, DRAFT assessment).
r.use(assessmentMediaRouter(content));

r.get('/assignments', content, withQuery(facultyAssignmentListQuerySchema), c.assignments);
r.get('/assignments/:id', content, byId, c.assignment);
r.post('/chapters/:id/assignments', content, withBody(assignmentCreateSchema), c.createAssignment);
r.put(
  '/lessons/:id/assignment',
  content,
  withBody(assignmentSettingsSchema),
  c.saveAssignmentSettings,
);

r.get('/submissions', grading, withQuery(submissionListQuerySchema), c.submissions);
r.get('/submissions/:id', grading, byId, c.submission);
r.put('/submissions/:id/grade', grading, withBody(gradeSubmissionSchema), c.grade);
r.post('/submissions/:id/release', grading, byId, c.release);

// Assessment engine (PHASE 09, docs/ASSESSMENTS.md §9). Authoring needs content.manage_assigned;
// attempts, manual grading and result publication need submissions.grade_assigned.
r.get('/quizzes', content, withQuery(facultyQuizListQuerySchema), a.quizzes);
r.get('/quizzes/:id', content, byId, a.quiz);
r.post('/chapters/:id/quizzes', content, withBody(quizCreateSchema), a.createQuiz);
r.put('/lessons/:id/quiz', content, withBody(quizSettingsSchema), a.saveQuizSettings);
r.post('/quizzes/:id/questions', content, withBody(questionInputSchema), a.addQuizQuestion);
r.put(
  '/quizzes/:id/question-order',
  content,
  withBody(questionOrderSchema),
  a.reorderQuizQuestions,
);
r.post('/quizzes/:id/status', content, withBody(assessmentTransitionSchema), a.quizTransition);
r.post('/quizzes/:id/publish-results', grading, byId, a.publishQuizResults);
r.get('/quizzes/:id/attempts', grading, withIdQuery(attemptListQuerySchema), a.quizAttempts);

r.get('/exams', content, withQuery(facultyExamListQuerySchema), a.exams);
r.post('/courses/:id/exams', content, withBody(examCreateSchema), a.createExam);
r.get('/exams/:id', content, byId, a.exam);
r.patch('/exams/:id', content, withBody(examUpdateSchema), a.updateExam);
r.delete('/exams/:id', content, byId, a.deleteExam);
r.post('/exams/:id/questions', content, withBody(questionInputSchema), a.addExamQuestion);
r.put('/exams/:id/question-order', content, withBody(questionOrderSchema), a.reorderExamQuestions);
r.post('/exams/:id/status', content, withBody(assessmentTransitionSchema), a.examTransition);
r.post('/exams/:id/publish-results', grading, byId, a.publishExamResults);
r.post('/exams/:id/process-expired', grading, byId, a.processExpired);
r.get('/exams/:id/attempts', grading, withIdQuery(attemptListQuerySchema), a.examAttempts);

r.patch('/questions/:id', content, withBody(questionInputSchema), a.updateQuestion);
r.delete('/questions/:id', content, byId, a.deleteQuestion);

r.get('/attempts/:id', grading, byId, a.attempt);
r.put('/attempt-answers/:id/grade', grading, withBody(answerGradeSchema), a.gradeAnswer);

r.get('/live-classes', classes, withQuery(liveClassListQuerySchema), c.liveClasses);
r.get('/live-classes/settings', classes, c.liveClassSettings);
r.post('/courses/:id/live-classes', classes, withBody(liveClassCreateSchema), c.createLiveClass);
r.patch('/live-classes/:id', classes, withBody(liveClassUpdateSchema), c.updateLiveClass);
r.post('/live-classes/:id/cancel', classes, byId, c.cancelLiveClass);
// PHASE 11: completion, Google Meet link creation/retry and manual recording links.
r.post('/live-classes/:id/complete', classes, byId, c.completeLiveClass);
r.post('/live-classes/:id/meeting', classes, byId, c.requestMeeting);
r.put('/live-classes/:id/recording', classes, withBody(liveClassRecordingSchema), c.setRecording);

r.get('/profile', own, c.profile);
r.patch('/profile', own, validateRequest({ body: facultyProfileUpdateSchema }), c.updateProfile);
