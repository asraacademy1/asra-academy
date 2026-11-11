import {
  PERMISSIONS,
  type ContinueLearningItem,
  type CourseProgressDto,
  type LearningHistoryItem,
  type LessonProgressUpdateDto,
  type Paginated,
  type StudentCatalogCourse,
  type StudentCourseCard,
  type StudentCourseOverview,
  type StudentCurriculumDto,
  type StudentDashboardDto,
  type StudentEnrollmentRecord,
  type StudentFeatures,
  type StudentLessonDto,
  type StudentLessonListItem,
  type StudentProfileDto,
} from '@asra/types';
import type {
  PaginationQuery,
  StudentCatalogQuery,
  StudentEnrollmentListQuery,
  StudentLessonListQuery,
  StudentProfileUpdateInput,
  VideoProgressInput,
} from '@asra/validation';
import { prisma } from '../../database/prisma.js';
import { clock } from '../../lib/clock.js';
import type { DbClient } from '../../database/types.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { accessPolicy } from '../../services/access-policy.service.js';
import type { AuthContext } from '../../types/auth.js';
import { AppError } from '../../utils/app-error.js';
import { withoutUndefined } from '../../utils/object.js';
import { pageArgs, paginated } from '../../utils/pagination.js';
import { dispatchAfterCommit } from '../notifications/dispatcher.js';
import { notificationProducers } from '../notifications/producers.js';
import { certificatesService } from '../certificates/certificates.service.js';
import {
  calculateCourseProgress,
  countsTowardProgress,
  creditVideoHeartbeat,
  isCourseComplete,
} from './progress.js';
import {
  accessStateFor,
  priceFor,
  studentFeatures,
  resolveResumeLesson,
  toCourseRef,
  toCourseView,
  toEnrollmentSummary,
  toInstructors,
  toLocator,
  toOutline,
  toProgressDto,
  toStudentCurriculum,
  toStudentResource,
  type CourseView,
} from './student.mappers.js';
import {
  courseRefSelect,
  createStudentRepository,
  type EnrollmentWithCourseRow,
  type StudentRepository,
} from './student.repository.js';

/**
 * Student LMS (PHASE 07, docs/STUDENT-LMS.md).
 *
 * Security model:
 *   - The student is ALWAYS `auth.userId`. No endpoint accepts a user id, enrolment id, price,
 *     payment status, score or progress percentage from the client.
 *   - Every lesson/resource/progress operation resolves the owning course from the DATABASE
 *     (lesson → chapter → module → course) and calls `accessPolicy.assertCanViewCourseContent`.
 *   - Only PUBLISHED lessons of PUBLISHED courses are ever returned; drafts are 404.
 *   - Reads have no side effects; last activity changes only on explicit learning actions.
 */

const DASHBOARD_COURSES = 6;
const CONTINUE_LEARNING = 3;
const COMPLETED_COURSES = 5;

const notFound = (entity: string): never => {
  throw new AppError('NOT_FOUND', `${entity} not found`);
};

const repoFor = (db: DbClient = prisma) => createStudentRepository(db);

// --- Helpers --------------------------------------------------------------------------------

/** Course progress for one student and course, from authoritative rows. */
async function computeCourseProgress(
  repo: StudentRepository,
  userId: string,
  courseId: string,
  completedAt: Date | null,
): Promise<{ view: CourseView; progress: CourseProgressDto }> {
  const [structures, completed] = await Promise.all([
    repo.structures([courseId]),
    repo.progress.completedInCourses(userId, [courseId]),
  ]);
  const view = toCourseView(structures.get(courseId));
  const progress = calculateCourseProgress(
    view.eligibleIds,
    new Set(completed.map((row) => row.lessonId)),
    completedAt,
  );
  return { view, progress };
}

/** Course cards for a page of enrolments: two queries in total, whatever the page size. */
async function toCourseCards(
  repo: StudentRepository,
  userId: string,
  rows: EnrollmentWithCourseRow[],
): Promise<StudentCourseCard[]> {
  const courseIds = rows.map((row) => row.courseId);
  const [structures, completed] = await Promise.all([
    repo.structures(courseIds),
    repo.progress.completedInCourses(userId, courseIds),
  ]);
  const completedIds = new Set(completed.map((row) => row.lessonId));
  return rows.map((row) => {
    const view = toCourseView(structures.get(row.courseId));
    const resume = resolveResumeLesson(view, row.lastLessonId);
    return {
      ...toCourseRef(row.course),
      enrollment: toEnrollmentSummary(row),
      progress: calculateCourseProgress(view.eligibleIds, completedIds, row.completedAt),
      resumeLesson: resume ? toLocator(resume) : null,
    };
  });
}

/** Curriculum with the student's completion marks; the caller has already checked access. */
async function buildCurriculum(
  repo: StudentRepository,
  userId: string,
  courseId: string,
  view: CourseView,
  enrollment: { completedAt: Date | null; lastLessonId: string | null },
): Promise<StudentCurriculumDto> {
  const rows = await repo.progress.forLessons(
    userId,
    view.lessons.map((lesson) => lesson.id),
  );
  const completedAt = new Map(rows.map((row) => [row.lessonId, row.completedAt]));
  const completedIds = new Set(rows.filter((row) => row.completedAt).map((row) => row.lessonId));
  return {
    courseId,
    modules: toStudentCurriculum(view, completedAt),
    progress: calculateCourseProgress(view.eligibleIds, completedIds, enrollment.completedAt),
    resumeLessonId: resolveResumeLesson(view, enrollment.lastLessonId)?.id ?? null,
  };
}

/** Resolves a lesson to its course and checks the student's access. Drafts are 404. */
async function requireAccessibleLesson(auth: AuthContext, lessonId: string, db: DbClient = prisma) {
  const lesson = await repoFor(db).lessons.findOwner(lessonId);
  if (!lesson || lesson.status !== 'PUBLISHED') notFound('Lesson');
  const owner = lesson!;
  const courseId = owner.chapter.module.courseId;
  const enrollment = await accessPolicy.assertCanViewCourseContent(auth, courseId, db);
  return { lesson: owner, courseId, enrollment };
}

/**
 * Applies a learning action in ONE transaction: locks the progress row, lets `change` update it,
 * moves the course's resume point/last activity, recomputes course progress and records the
 * course completion the first time it is reached.
 */
async function recordLearningAction(
  auth: AuthContext,
  lessonId: string,
  change: (
    repo: StudentRepository,
    current: Awaited<ReturnType<StudentRepository['progress']['lock']>>,
    lesson: Awaited<ReturnType<typeof requireAccessibleLesson>>['lesson'],
    now: Date,
  ) => Promise<Awaited<ReturnType<StudentRepository['progress']['update']>>>,
): Promise<LessonProgressUpdateDto> {
  const result = await prisma.$transaction(async (tx) => {
    const { lesson, courseId, enrollment } = await requireAccessibleLesson(auth, lessonId, tx);
    const repo = repoFor(tx);
    const now = new Date();
    const current = await repo.progress.lock(auth.userId, lessonId, now);
    const updated = await change(repo, current, lesson, now);
    await repo.enrollments.touch(enrollment.id, lessonId, now);

    const { progress } = await computeCourseProgress(
      repo,
      auth.userId,
      courseId,
      enrollment.completedAt,
    );
    let course = progress;
    let newlyCompleted = false;
    if (enrollment.completedAt === null && isCourseComplete(progress)) {
      await repo.enrollments.markCompleted(enrollment.id, now);
      course = { ...progress, completedAt: now.toISOString() };
      newlyCompleted = true;
    }
    return { lessonId, progress: toProgressDto(updated), course, courseId, newlyCompleted };
  });

  if (result.newlyCompleted) {
    void prisma.certificateSettings
      .findUnique({ where: { id: 'default' }, select: { autoIssueOnCourseCompletion: true } })
      .then((settings) => {
        if (settings?.autoIssueOnCourseCompletion !== false) {
          return certificatesService.issueCertificate(auth, result.courseId);
        }
        return undefined;
      })
      .catch(() => {});
  }

  return { lessonId: result.lessonId, progress: result.progress, course: result.course };
}

// --- Service --------------------------------------------------------------------------------

export const studentService = {
  features(): StudentFeatures {
    return studentFeatures();
  },

  async dashboard(auth: AuthContext): Promise<StudentDashboardDto> {
    const repo = repoFor();
    const accessible = repo.enrollments.accessibleWhere(auth.userId);
    const [rows, totalCourses, completedCourseRows, completedLessons, allAccessible, user] =
      await Promise.all([
        repo.enrollments.list(accessible, 0, DASHBOARD_COURSES),
        repo.enrollments.count(accessible),
        prisma.enrollment.findMany({
          where: { ...accessible, completedAt: { not: null } },
          orderBy: { completedAt: 'desc' },
          select: { completedAt: true, course: { select: courseRefSelect } },
          take: COMPLETED_COURSES,
        }),
        prisma.lessonProgress.count({
          where: {
            userId: auth.userId,
            completedAt: { not: null },
            lesson: {
              status: 'PUBLISHED',
              chapter: { module: { course: { status: 'PUBLISHED' } } },
            },
          },
        }),
        prisma.enrollment.findMany({ where: accessible, select: { courseId: true } }),
        prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { fullName: true } }),
      ]);

    const courseIds = allAccessible.map((row) => row.courseId);
    const lessonsOfType = (contentType: 'QUIZ' | 'ASSIGNMENT') =>
      courseIds.length === 0
        ? Promise.resolve(0)
        : prisma.lesson.count({
            where: {
              status: 'PUBLISHED',
              contentType,
              chapter: { module: { courseId: { in: courseIds } } },
            },
          });
    const [courses, quizzes, assignments, exams, completedCount] = await Promise.all([
      toCourseCards(repo, auth.userId, rows),
      lessonsOfType('QUIZ'),
      lessonsOfType('ASSIGNMENT'),
      courseIds.length === 0
        ? Promise.resolve(0)
        : prisma.examination.count({
            where: {
              courseId: { in: courseIds },
              status: 'PUBLISHED',
              closesAt: { gt: clock.now() },
            },
          }),
      prisma.enrollment.count({ where: { ...accessible, completedAt: { not: null } } }),
    ]);

    const continueLearning: ContinueLearningItem[] = courses
      .filter((card) => card.enrollment.lastActivityAt !== null && card.resumeLesson !== null)
      .slice(0, CONTINUE_LEARNING)
      .map((card) => ({
        course: {
          id: card.id,
          title: card.title,
          slug: card.slug,
          thumbnailUrl: card.thumbnailUrl,
          category: card.category,
          class: card.class,
          stream: card.stream,
          subject: card.subject,
        },
        lesson: card.resumeLesson!,
        progress: card.progress,
        lastActivityAt: card.enrollment.lastActivityAt!,
      }));

    return {
      student: { fullName: user.fullName },
      stats: { activeCourses: totalCourses, completedCourses: completedCount, completedLessons },
      continueLearning,
      courses,
      totalCourses,
      assessments: { quizzes, assignments, exams },
      completedCourses: completedCourseRows.map((row) => ({
        course: toCourseRef(row.course),
        completedAt: row.completedAt!.toISOString(),
      })),
      features: studentFeatures(),
    };
  },

  /** Courses the student is currently entitled to (ACTIVE enrolment, PUBLISHED course). */
  async courses(auth: AuthContext, query: PaginationQuery): Promise<Paginated<StudentCourseCard>> {
    const repo = repoFor();
    const where = repo.enrollments.accessibleWhere(auth.userId);
    const { skip, take } = pageArgs(query);
    const [rows, total] = await Promise.all([
      repo.enrollments.list(where, skip, take),
      repo.enrollments.count(where),
    ]);
    return paginated(await toCourseCards(repo, auth.userId, rows), total, query);
  },

  /** Every enrolment record of the student, including cancelled ones (profile history). */
  async enrollments(
    auth: AuthContext,
    query: StudentEnrollmentListQuery,
  ): Promise<Paginated<StudentEnrollmentRecord>> {
    const repo = repoFor();
    const where: Prisma.EnrollmentWhereInput = {
      userId: auth.userId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.completed === undefined
        ? {}
        : { completedAt: query.completed ? { not: null } : null }),
    };
    const { skip, take } = pageArgs(query);
    const [rows, total] = await Promise.all([
      repo.enrollments.list(where, skip, take),
      repo.enrollments.count(where),
    ]);
    return paginated(
      rows.map((row) => ({
        course: toCourseRef(row.course),
        enrollment: toEnrollmentSummary(row),
        completedAt: row.completedAt?.toISOString() ?? null,
      })),
      total,
      query,
    );
  },

  /** Published, publicly listed courses with what the student must do to access each one. */
  async catalog(
    auth: AuthContext,
    query: StudentCatalogQuery,
  ): Promise<Paginated<StudentCatalogCourse>> {
    const repo = repoFor();
    const where: Prisma.CourseWhereInput = query.q
      ? {
          OR: [
            { title: { contains: query.q, mode: 'insensitive' } },
            { summary: { contains: query.q, mode: 'insensitive' } },
            { subject: { name: { contains: query.q, mode: 'insensitive' } } },
          ],
        }
      : {};
    const { skip, take } = pageArgs(query);
    const [rows, total] = await Promise.all([
      repo.course.catalog(where, skip, take),
      repo.course.catalogCount(where),
    ]);
    const enrollments = await prisma.enrollment.findMany({
      where: { userId: auth.userId, courseId: { in: rows.map((row) => row.id) } },
      select: { courseId: true, status: true },
    });
    const byCourse = new Map(enrollments.map((row) => [row.courseId, row]));
    return paginated(
      rows.map((row) => ({
        ...toCourseRef(row),
        summary: row.summary,
        durationMinutes: row.durationMinutes,
        instructors: toInstructors(row.instructors),
        access: accessStateFor(row, byCourse.get(row.id) ?? null),
        price: priceFor(row),
      })),
      total,
      query,
    );
  },

  /**
   * Course overview. Published PUBLIC/UNLISTED courses are visible to any student (with the
   * outline only); the curriculum with lesson ids and progress is returned only when enrolled.
   */
  async courseOverview(auth: AuthContext, courseId: string): Promise<StudentCourseOverview> {
    const repo = repoFor();
    const [course, enrollment] = await Promise.all([
      repo.course.findOverview(courseId),
      repo.enrollments.find(auth.userId, courseId),
    ]);
    if (!course || course.status !== 'PUBLISHED') notFound('Course');
    const row = course!;
    const enrolled = enrollment?.status === 'ACTIVE';
    if (row.visibility === 'PRIVATE' && !enrolled) notFound('Course');

    const view = toCourseView((await repo.structures([courseId])).get(courseId));
    let curriculum: StudentCurriculumDto | null = null;
    let resumeLesson = null;
    if (enrolled) {
      curriculum = await buildCurriculum(repo, auth.userId, courseId, view, enrollment!);
      const resume = resolveResumeLesson(view, enrollment!.lastLessonId);
      resumeLesson = resume ? toLocator(resume) : null;
    }

    return {
      ...toCourseRef(row),
      summary: row.summary,
      description: row.description,
      durationMinutes: row.durationMinutes,
      instructors: toInstructors(row.instructors),
      access: accessStateFor(row, enrollment),
      price: priceFor(row),
      enrollment: enrollment ? toEnrollmentSummary(enrollment) : null,
      outline: toOutline(view),
      lessonCount: view.lessons.length,
      curriculum,
      resumeLesson,
    };
  },

  async curriculum(auth: AuthContext, courseId: string): Promise<StudentCurriculumDto> {
    const enrollment = await accessPolicy.assertCanViewCourseContent(auth, courseId);
    const repo = repoFor();
    const view = toCourseView((await repo.structures([courseId])).get(courseId));
    return buildCurriculum(repo, auth.userId, courseId, view, enrollment);
  },

  async courseProgress(auth: AuthContext, courseId: string): Promise<CourseProgressDto> {
    const enrollment = await accessPolicy.assertCanViewCourseContent(auth, courseId);
    return (await computeCourseProgress(repoFor(), auth.userId, courseId, enrollment.completedAt))
      .progress;
  },

  /** The lesson player payload. No side effects: opening is recorded by `recordActivity`. */
  async lesson(auth: AuthContext, lessonId: string): Promise<StudentLessonDto> {
    const repo = repoFor();
    const lesson = await repo.lessons.findWithOwner(lessonId);
    if (!lesson || lesson.status !== 'PUBLISHED') notFound('Lesson');
    const row = lesson!;
    const courseId = row.chapter.module.courseId;
    await accessPolicy.assertCanViewCourseContent(auth, courseId);

    const [course, structures, progress] = await Promise.all([
      prisma.course.findUniqueOrThrow({
        where: { id: courseId },
        select: { id: true, title: true },
      }),
      repo.structures([courseId]),
      repo.progress.find(auth.userId, lessonId),
    ]);
    const { lessons } = toCourseView(structures.get(courseId));
    const index = lessons.findIndex((item) => item.id === lessonId);
    const target = (item: (typeof lessons)[number] | undefined) =>
      item ? { id: item.id, title: item.title, contentType: item.contentType } : null;

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      contentType: row.contentType,
      body: row.body,
      durationSeconds: row.durationSeconds,
      course,
      module: { id: row.chapter.module.id, title: row.chapter.module.title },
      chapter: { id: row.chapter.id, title: row.chapter.title },
      resources: row.resources.map(toStudentResource),
      progress: progress ? toProgressDto(progress) : null,
      countsTowardProgress: countsTowardProgress(row.contentType),
      navigation: {
        previous: index > 0 ? target(lessons[index - 1]) : null,
        next: index >= 0 ? target(lessons[index + 1]) : null,
        position: index + 1,
        total: lessons.length,
      },
    };
  },

  /** Resources of one lesson (same access rules as the lesson). */
  async lessonResources(auth: AuthContext, lessonId: string) {
    const lesson = await repoFor().lessons.findWithOwner(lessonId);
    if (!lesson || lesson.status !== 'PUBLISHED') notFound('Lesson');
    await accessPolicy.assertCanViewCourseContent(auth, lesson!.chapter.module.courseId);
    return lesson!.resources.map(toStudentResource);
  },

  /** The student opened the lesson: first/last viewed + the course's resume point. */
  recordActivity(auth: AuthContext, lessonId: string): Promise<LessonProgressUpdateDto> {
    return recordLearningAction(auth, lessonId, (repo, _current, _lesson, now) =>
      repo.progress.update(auth.userId, lessonId, { lastViewedAt: now }),
    );
  },

  /** Idempotent: completing twice keeps the first completion time and creates no new row. */
  complete(auth: AuthContext, lessonId: string): Promise<LessonProgressUpdateDto> {
    return recordLearningAction(auth, lessonId, (repo, current, lesson, now) => {
      if (!countsTowardProgress(lesson.contentType)) {
        throw new AppError(
          'CONFLICT',
          'Quiz and assignment lessons cannot be marked complete yet: online attempts and submissions are not available.',
        );
      }
      return repo.progress.update(auth.userId, lessonId, {
        lastViewedAt: now,
        completedAt: current.completedAt ?? now,
      });
    });
  },

  /**
   * "Mark as not complete" — lets a student correct an accidental click. The course's first
   * completion date (`enrollments.completed_at`) is history and is not cleared.
   */
  reopen(auth: AuthContext, lessonId: string): Promise<LessonProgressUpdateDto> {
    return recordLearningAction(auth, lessonId, (repo, _current, _lesson, now) =>
      repo.progress.update(auth.userId, lessonId, { lastViewedAt: now, completedAt: null }),
    );
  },

  /** Throttled video heartbeat (docs/STUDENT-LMS.md §5). */
  recordVideoProgress(
    auth: AuthContext,
    lessonId: string,
    input: VideoProgressInput,
  ): Promise<LessonProgressUpdateDto> {
    return recordLearningAction(auth, lessonId, (repo, current, lesson, now) => {
      if (lesson.contentType !== 'VIDEO') {
        throw new AppError('BAD_REQUEST', 'Playback progress can only be saved for video lessons');
      }
      const credit = creditVideoHeartbeat(
        { watchedSeconds: current.videoWatchedSeconds, heartbeatAt: current.videoHeartbeatAt },
        input,
        lesson.durationSeconds,
        now,
      );
      return repo.progress.update(auth.userId, lessonId, {
        lastViewedAt: now,
        videoPositionSeconds: credit.positionSeconds,
        videoWatchedSeconds: credit.watchedSeconds,
        videoHeartbeatAt: now,
        videoCompletedAt: current.videoCompletedAt ?? (credit.reachedThreshold ? now : null),
      });
    });
  },

  /** Published lessons of one kind (quizzes, assignments, recorded lectures) in enrolled courses. */
  async lessonsByType(
    auth: AuthContext,
    query: StudentLessonListQuery,
  ): Promise<Paginated<StudentLessonListItem>> {
    const repo = repoFor();
    let courseIds: string[];
    if (query.courseId) {
      await accessPolicy.assertCanViewCourseContent(auth, query.courseId);
      courseIds = [query.courseId];
    } else {
      courseIds = (
        await prisma.enrollment.findMany({
          where: repo.enrollments.accessibleWhere(auth.userId),
          select: { courseId: true },
        })
      ).map((row) => row.courseId);
    }
    if (courseIds.length === 0) return paginated([], 0, query);

    const { skip, take } = pageArgs(query);
    const [rows, total] = await repo.lessons.listByType(courseIds, query.contentType, skip, take);
    const progress = await repo.progress.forLessons(
      auth.userId,
      rows.map((row) => row.id),
    );
    const completedAt = new Map(progress.map((row) => [row.lessonId, row.completedAt]));
    return paginated(
      rows.map((row) => ({
        course: toCourseRef(row.chapter.module.course),
        lesson: {
          lessonId: row.id,
          lessonTitle: row.title,
          contentType: row.contentType,
          chapterTitle: row.chapter.title,
          moduleTitle: row.chapter.module.title,
        },
        durationSeconds: row.durationSeconds,
        completedAt: completedAt.get(row.id)?.toISOString() ?? null,
      })),
      total,
      query,
    );
  },

  /** The student's own recent lesson activity, newest first. */
  async history(
    auth: AuthContext,
    query: PaginationQuery,
  ): Promise<Paginated<LearningHistoryItem>> {
    const repo = repoFor();
    const { skip, take } = pageArgs(query);
    const [rows, total] = await Promise.all([
      repo.progress.history(auth.userId, skip, take),
      repo.progress.historyCount(auth.userId),
    ]);
    return paginated(
      rows.map((row) => ({
        course: toCourseRef(row.lesson.chapter.module.course),
        lesson: {
          lessonId: row.lesson.id,
          lessonTitle: row.lesson.title,
          contentType: row.lesson.contentType,
          chapterTitle: row.lesson.chapter.title,
          moduleTitle: row.lesson.chapter.module.title,
        },
        firstViewedAt: row.firstViewedAt.toISOString(),
        lastViewedAt: row.lastViewedAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
      })),
      total,
      query,
    );
  },

  // Profile -----------------------------------------------------------------------------------

  async profile(auth: AuthContext): Promise<StudentProfileDto> {
    const row = (await repoFor().student.profile(auth.userId)) ?? notFound('Profile');
    const academic = row!.studentProfile;
    const level = academic?.class?.academicLevel ?? academic?.stream?.academicLevel ?? null;
    const ref = (value: { name: string; slug: string } | null | undefined) =>
      value ? { name: value.name, slug: value.slug } : null;
    return {
      fullName: row!.fullName,
      email: row!.email,
      phone: row!.phone,
      emailVerified: row!.emailVerifiedAt !== null,
      memberSince: row!.createdAt.toISOString(),
      studentCode: academic?.studentCode ?? null,
      academicLevel: ref(level),
      class: ref(academic?.class),
      stream: ref(academic?.stream),
    };
  },

  /** Only `fullName` and `phone` — the schema is strict, so nothing else can be over-posted. */
  async updateProfile(
    auth: AuthContext,
    input: StudentProfileUpdateInput,
  ): Promise<StudentProfileDto> {
    await repoFor().student.updateUser(auth.userId, withoutUndefined(input));
    return studentService.profile(auth);
  },

  // Enrolment -----------------------------------------------------------------------------------

  /**
   * Self-enrolment on a FREE course (price explicitly 0) — no order or payment is created.
   * Paid courses go through checkout (PHASE 10, docs/PAYMENTS.md); unpriced and PRIVATE courses
   * are enrolled by the academy. Idempotent for an active enrolment; a cancelled enrolment is not
   * reopened by the student (D-04).
   */
  async enrollFree(
    auth: AuthContext,
    courseId: string,
  ): Promise<{ created: boolean; course: StudentCourseOverview }> {
    if (!auth.permissions.has(PERMISSIONS.CONTENT_VIEW_ENROLLED)) {
      throw new AppError('FORBIDDEN', 'You do not have permission to perform this action');
    }
    const { created, deliveries } = await prisma.$transaction(async (tx) => {
      const repo = repoFor(tx);
      if (!(await repo.course.lock(courseId))) notFound('Course');
      const course = (await repo.course.findForAccess(courseId))!;
      if (course.status !== 'PUBLISHED' || course.visibility === 'PRIVATE') notFound('Course');
      const existing = await repo.enrollments.find(auth.userId, courseId);
      if (existing?.status === 'ACTIVE') return { created: false, deliveries: [] as string[] };
      if (existing?.status === 'CANCELLED') {
        throw new AppError(
          'CONFLICT',
          'Your enrolment in this course was cancelled. Please contact the academy.',
        );
      }
      if (course.priceMinor !== 0) {
        throw new AppError(
          'FORBIDDEN',
          'This course is not free. Buy it from the checkout page, or contact the academy.',
        );
      }
      const enrollment = await tx.enrollment.create({
        data: { userId: auth.userId, courseId, source: 'FREE', status: 'ACTIVE' },
        select: { id: true },
      });
      // PHASE 11: confirmation once the enrolment commits (in-app + email).
      return {
        created: true,
        deliveries: await notificationProducers.enrollmentActivated(tx, enrollment.id),
      };
    });
    dispatchAfterCommit(deliveries);
    return { created, course: await studentService.courseOverview(auth, courseId) };
  },
};
