import {
  PERMISSIONS,
  type AttemptStartDto,
  type FacultyQuizDetail,
  type FacultyQuizItem,
  type Paginated,
  type QuestionDto,
  type QuizSettingsDto,
  type StudentQuizDto,
} from '@asra/types';
import type {
  AssessmentTransition,
  FacultyQuizListQuery,
  QuestionInput,
  QuestionOrderInput,
  QuizCreateInput,
  QuizSettingsInput,
} from '@asra/validation';
import { prisma } from '../../database/prisma.js';
import type { DbClient } from '../../database/types.js';
import { Prisma } from '../../generated/prisma/client.js';
import { clock } from '../../lib/clock.js';
import { accessPolicy } from '../../services/access-policy.service.js';
import type { AuthContext } from '../../types/auth.js';
import { AppError, fieldError } from '../../utils/app-error.js';
import { pageArgs, paginated } from '../../utils/pagination.js';
import { coursePublicationGuard } from '../courses/courses.service.js';
import { createCurriculumRepository } from '../curriculum/curriculum.repository.js';
import {
  attemptCounts,
  attemptSummarySelect,
  emptyCounts,
  expireIfDue,
  finalizeAllInProgress,
  findAttempt,
  lockAttempt,
  lockStudentAssessment,
  questionImageRefs,
  rethrowAttemptRace,
  selectQuestions,
  sourceQuestionSelect,
  sweepExpiredAttempts,
  toStudentAttempt,
  toStudentSummary,
} from './attempts.core.js';
import { dispatchAfterCommit } from '../notifications/dispatcher.js';
import { notificationProducers } from '../notifications/producers.js';
import { audit } from './audit.js';
import {
  listQuestions,
  questionAuthoring,
  questionTotals,
  type OwnerContext,
} from './questions.service.js';
import { fromCents, toCents } from './scoring.js';

/**
 * Quizzes (PHASE 09, docs/ASSESSMENTS.md §5). A quiz is the online part of a QUIZ lesson: the
 * lesson (curriculum, Phase 06) holds title, instructions and lesson publication; `Quiz` holds the
 * rules, the questions and the attempts. Faculty access is course-scoped exactly like PHASE 08
 * assignments: the course is resolved from the database and `assertTeachesCourse` is required.
 */

const notFound = (entity: string): never => {
  throw new AppError('NOT_FOUND', `${entity} not found`);
};

const lessonChain = {
  chapter: {
    select: {
      id: true,
      title: true,
      module: { select: { id: true, title: true, course: { select: { id: true, title: true } } } },
    },
  },
} satisfies Prisma.LessonSelect;

const quizSettingsSelect = {
  id: true,
  status: true,
  timeLimitMinutes: true,
  maxAttempts: true,
  passPercent: true,
  negativeMarking: true,
  shuffleQuestions: true,
  shuffleOptions: true,
  questionsPerAttempt: true,
  showResultImmediately: true,
  answerReveal: true,
  resultsPublishedAt: true,
  publishedAt: true,
  closedAt: true,
  updatedAt: true,
} satisfies Prisma.QuizSelect;

const quizLessonSelect = {
  id: true,
  title: true,
  body: true,
  status: true,
  contentType: true,
  updatedAt: true,
  ...lessonChain,
  quiz: { select: quizSettingsSelect },
} satisfies Prisma.LessonSelect;

type QuizLessonRow = Prisma.LessonGetPayload<{ select: typeof quizLessonSelect }>;
type QuizSettingsRow = NonNullable<QuizLessonRow['quiz']>;

function toSettings(row: QuizSettingsRow): QuizSettingsDto {
  return {
    id: row.id,
    status: row.status,
    timeLimitMinutes: row.timeLimitMinutes,
    maxAttempts: row.maxAttempts,
    passPercent: row.passPercent,
    negativeMarking: row.negativeMarking,
    shuffleQuestions: row.shuffleQuestions,
    shuffleOptions: row.shuffleOptions,
    questionsPerAttempt: row.questionsPerAttempt,
    showResultImmediately: row.showResultImmediately,
    answerReveal: row.answerReveal,
    resultsPublishedAt: row.resultsPublishedAt?.toISOString() ?? null,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function requireQuizLesson(lessonId: string, db: DbClient = prisma): Promise<QuizLessonRow> {
  const row = await db.lesson.findUnique({ where: { id: lessonId }, select: quizLessonSelect });
  if (!row || row.contentType !== 'QUIZ') notFound('Quiz');
  return row!;
}

/** The quiz lesson after checking the caller teaches its course (with `permission`). */
async function authorisedQuizLesson(
  auth: AuthContext,
  lessonId: string,
  permission: (typeof PERMISSIONS)[keyof typeof PERMISSIONS] = PERMISSIONS.CONTENT_MANAGE_ASSIGNED,
  db: DbClient = prisma,
) {
  const row = await requireQuizLesson(lessonId, db);
  await accessPolicy.assertTeachesCourse(auth, row.chapter.module.course.id, permission, db);
  return row;
}

function requireQuiz(row: QuizLessonRow): QuizSettingsRow {
  if (!row.quiz) {
    throw new AppError('CONFLICT', 'Set up the online quiz for this lesson first.');
  }
  return row.quiz;
}

async function lockQuiz(tx: DbClient, quizId: string) {
  await tx.$queryRaw`SELECT "id" FROM "quizzes" WHERE "id" = ${quizId}::uuid FOR UPDATE`;
}

const ruleData = (input: QuizSettingsInput) => ({
  timeLimitMinutes: input.timeLimitMinutes,
  maxAttempts: input.maxAttempts,
  passPercent: input.passPercent,
  negativeMarking: input.negativeMarking,
  shuffleQuestions: input.shuffleQuestions,
  shuffleOptions: input.shuffleOptions,
  questionsPerAttempt: input.questionsPerAttempt,
  showResultImmediately: input.showResultImmediately,
  answerReveal: input.answerReveal,
});

function toItem(
  row: QuizLessonRow,
  totals: Map<string, { count: number; marks: number }>,
  counts: Awaited<ReturnType<typeof attemptCounts>>,
): FacultyQuizItem {
  const quizId = row.quiz?.id;
  const total = (quizId && totals.get(quizId)) || { count: 0, marks: 0 };
  return {
    lessonId: row.id,
    title: row.title,
    lessonStatus: row.status,
    course: row.chapter.module.course,
    module: { id: row.chapter.module.id, title: row.chapter.module.title },
    chapter: { id: row.chapter.id, title: row.chapter.title },
    quiz: row.quiz ? toSettings(row.quiz) : null,
    questionCount: total.count,
    totalMarks: total.marks,
    attempts: (quizId && counts.get(quizId)) || emptyCounts(),
    updatedAt: (row.quiz?.updatedAt ?? row.updatedAt).toISOString(),
  };
}

async function decorate(rows: QuizLessonRow[]) {
  const ids = rows.flatMap((row) => (row.quiz ? [row.quiz.id] : []));
  const [totals, counts] = await Promise.all([
    ids.length ? questionTotals({ quizId: { in: ids } }, 'quizId') : new Map(),
    attemptCounts({ quizId: { in: ids } }),
  ]);
  return rows.map((row) => toItem(row, totals, counts));
}

/** Owner context for the shared question authoring (re-read inside its transaction). */
const ownerResolver =
  (auth: AuthContext, lessonId: string) =>
  async (tx: DbClient): Promise<OwnerContext> => {
    const row = await authorisedQuizLesson(auth, lessonId, undefined, tx);
    const quiz = requireQuiz(row);
    return {
      owner: { quizId: quiz.id },
      courseId: row.chapter.module.course.id,
      status: quiz.status,
      kind: 'QUIZ',
    };
  };

// --- Faculty --------------------------------------------------------------------------------

export const facultyQuizService = {
  async list(auth: AuthContext, query: FacultyQuizListQuery): Promise<Paginated<FacultyQuizItem>> {
    let ids = await accessPolicy.taughtCourseIds(auth, PERMISSIONS.CONTENT_MANAGE_ASSIGNED);
    if (query.courseId) {
      if (!ids.includes(query.courseId)) {
        throw new AppError('FORBIDDEN', 'You are not assigned to this course');
      }
      ids = [query.courseId];
    }
    if (ids.length === 0) return paginated([], 0, query);
    const where: Prisma.LessonWhereInput = {
      contentType: 'QUIZ',
      chapter: { module: { courseId: { in: ids } } },
    };
    const { skip, take } = pageArgs(query);
    const [rows, total] = await Promise.all([
      prisma.lesson.findMany({
        where,
        select: quizLessonSelect,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      prisma.lesson.count({ where }),
    ]);
    return paginated(await decorate(rows), total, query);
  },

  async detail(auth: AuthContext, lessonId: string): Promise<FacultyQuizDetail> {
    const row = await authorisedQuizLesson(auth, lessonId);
    const [item] = await decorate([row]);
    const [questions, activeStudents] = await Promise.all([
      row.quiz ? listQuestions({ quizId: row.quiz.id }) : Promise.resolve([]),
      prisma.enrollment.count({
        where: { courseId: row.chapter.module.course.id, status: 'ACTIVE' },
      }),
    ]);
    return { ...item!, instructions: row.body, questions, activeStudents };
  },

  /** Creates a DRAFT QUIZ lesson at the end of the chapter plus its DRAFT quiz, atomically. */
  async create(
    auth: AuthContext,
    chapterId: string,
    input: QuizCreateInput,
  ): Promise<FacultyQuizDetail> {
    const owner =
      (await createCurriculumRepository(prisma).chapterOwner(chapterId)) ?? notFound('Chapter');
    const courseId = owner.module.courseId;
    const lessonId = await prisma.$transaction(async (tx) => {
      await accessPolicy.assertTeachesCourse(
        auth,
        courseId,
        PERMISSIONS.CONTENT_MANAGE_ASSIGNED,
        tx,
      );
      if (!(await createCurriculumRepository(tx).lockCourse(courseId))) notFound('Course');
      const lesson = await createCurriculumRepository(tx).lessons.create(chapterId, {
        title: input.title,
        description: null,
        contentType: 'QUIZ',
        body: input.instructions ?? null,
        status: 'DRAFT',
        publishedAt: null,
      });
      await tx.quiz.create({
        data: { lessonId: lesson.id, createdById: auth.userId, ...ruleData(input) },
      });
      await coursePublicationGuard.assertStillPublishable(tx, courseId);
      return lesson.id;
    });
    return facultyQuizService.detail(auth, lessonId);
  },

  /** Creates or replaces the rules of a QUIZ lesson's quiz — only while the quiz is a DRAFT. */
  async saveSettings(
    auth: AuthContext,
    lessonId: string,
    input: QuizSettingsInput,
  ): Promise<FacultyQuizDetail> {
    await prisma.$transaction(async (tx) => {
      const row = await authorisedQuizLesson(auth, lessonId, undefined, tx);
      if (!row.quiz) {
        await tx.quiz.create({ data: { lessonId, createdById: auth.userId, ...ruleData(input) } });
        return;
      }
      await lockQuiz(tx, row.quiz.id);
      const current = await tx.quiz.findUniqueOrThrow({
        where: { id: row.quiz.id },
        select: { status: true },
      });
      if (current.status !== 'DRAFT') {
        throw new AppError(
          'CONFLICT',
          'The rules of a published quiz cannot change. Unpublish it first (possible only before anyone has attempted it).',
        );
      }
      await tx.quiz.update({ where: { id: row.quiz.id }, data: ruleData(input) });
    });
    return facultyQuizService.detail(auth, lessonId);
  },

  addQuestion(auth: AuthContext, lessonId: string, input: QuestionInput): Promise<QuestionDto> {
    return questionAuthoring.add(auth, ownerResolver(auth, lessonId), input);
  },

  reorderQuestions(auth: AuthContext, lessonId: string, input: QuestionOrderInput) {
    return questionAuthoring.reorder(ownerResolver(auth, lessonId), input);
  },

  /** DRAFT ⇄ PUBLISHED ⇄ CLOSED (docs/ASSESSMENTS.md §4). Invalid transitions are 409. */
  async transition(
    auth: AuthContext,
    lessonId: string,
    action: AssessmentTransition,
  ): Promise<FacultyQuizDetail> {
    await prisma.$transaction(async (tx) => {
      const row = await authorisedQuizLesson(auth, lessonId, undefined, tx);
      const quiz = requireQuiz(row);
      await lockQuiz(tx, quiz.id);
      const current = await tx.quiz.findUniqueOrThrow({
        where: { id: quiz.id },
        select: {
          status: true,
          questionsPerAttempt: true,
          _count: { select: { questions: true, attempts: true } },
        },
      });
      const now = clock.now();
      const refuse = (message: string): never => {
        throw new AppError('CONFLICT', message);
      };
      switch (action) {
        case 'publish': {
          if (current.status !== 'DRAFT')
            refuse(`Only a draft quiz can be published (it is ${current.status.toLowerCase()}).`);
          if (current._count.questions === 0)
            refuse('Add at least one question before publishing.');
          if (
            current.questionsPerAttempt !== null &&
            current.questionsPerAttempt > current._count.questions
          ) {
            throw fieldError(
              'VALIDATION_ERROR',
              'questionsPerAttempt',
              `Questions per attempt (${current.questionsPerAttempt}) is more than the ${current._count.questions} questions in this quiz.`,
            );
          }
          await tx.quiz.update({
            where: { id: quiz.id },
            data: { status: 'PUBLISHED', publishedAt: now, closedAt: null },
          });
          break;
        }
        case 'close': {
          if (current.status !== 'PUBLISHED') refuse('Only a published quiz can be closed.');
          // Running attempts end now with the answers saved so far (one finalization path).
          await finalizeAllInProgress(tx, { quizId: quiz.id }, now, auth.userId);
          await tx.quiz.update({
            where: { id: quiz.id },
            data: { status: 'CLOSED', closedAt: now },
          });
          break;
        }
        case 'reopen': {
          if (current.status !== 'CLOSED') refuse('Only a closed quiz can be reopened.');
          await tx.quiz.update({
            where: { id: quiz.id },
            data: { status: 'PUBLISHED', closedAt: null },
          });
          break;
        }
        case 'unpublish': {
          if (current.status !== 'PUBLISHED')
            refuse('Only a published quiz can be moved back to draft.');
          if (current._count.attempts > 0) {
            refuse(
              'Students have already attempted this quiz, so it cannot go back to draft. Close it instead.',
            );
          }
          await tx.quiz.update({
            where: { id: quiz.id },
            data: { status: 'DRAFT', publishedAt: null },
          });
          break;
        }
      }
      const actions = {
        publish: 'quiz.published',
        close: 'quiz.closed',
        reopen: 'quiz.reopened',
        unpublish: 'quiz.unpublished',
      } as const;
      await audit(tx, {
        action: actions[action],
        actorId: auth.userId,
        entityType: 'quiz',
        entityId: quiz.id,
      });
    });
    return facultyQuizService.detail(auth, lessonId);
  },

  /**
   * For quizzes whose scores are not shown immediately: makes every evaluated attempt's result
   * visible (and every later one). Idempotent.
   */
  async publishResults(
    auth: AuthContext,
    lessonId: string,
  ): Promise<{ published: boolean; quiz: FacultyQuizDetail }> {
    let deliveries: string[] = [];
    const published = await prisma.$transaction(async (tx) => {
      const row = await authorisedQuizLesson(
        auth,
        lessonId,
        PERMISSIONS.SUBMISSIONS_GRADE_ASSIGNED,
        tx,
      );
      const quiz = requireQuiz(row);
      await lockQuiz(tx, quiz.id);
      const current = await tx.quiz.findUniqueOrThrow({
        where: { id: quiz.id },
        select: { status: true, resultsPublishedAt: true },
      });
      if (current.resultsPublishedAt) return false;
      if (current.status === 'DRAFT')
        throw new AppError('CONFLICT', 'A draft quiz has no results to publish.');
      await tx.quiz.update({ where: { id: quiz.id }, data: { resultsPublishedAt: clock.now() } });
      await audit(tx, {
        action: 'quiz.results_published',
        actorId: auth.userId,
        entityType: 'quiz',
        entityId: quiz.id,
      });
      // PHASE 11: students who attempted it (and can still access the course) are notified.
      deliveries = await notificationProducers.quizResultsPublished(tx, quiz.id);
      return true;
    });
    dispatchAfterCommit(deliveries);
    return { published, quiz: await facultyQuizService.detail(auth, lessonId) };
  },

  /** The quiz id after the caller's grading access is checked (for attempt lists). */
  async quizIdForGrading(auth: AuthContext, lessonId: string): Promise<string> {
    const row = await authorisedQuizLesson(auth, lessonId, PERMISSIONS.SUBMISSIONS_GRADE_ASSIGNED);
    return requireQuiz(row).id;
  },
};

// --- Student --------------------------------------------------------------------------------

/** The published QUIZ lesson + the student's access to its course (drafts are 404). */
async function requireStudentQuizLesson(
  auth: AuthContext,
  lessonId: string,
  db: DbClient = prisma,
) {
  const lesson = await db.lesson.findUnique({
    where: { id: lessonId },
    select: {
      id: true,
      status: true,
      contentType: true,
      chapter: { select: { module: { select: { courseId: true } } } },
      quiz: { select: { ...quizSettingsSelect, _count: { select: { questions: true } } } },
    },
  });
  if (!lesson || lesson.status !== 'PUBLISHED') notFound('Lesson');
  await accessPolicy.assertCanViewCourseContent(auth, lesson!.chapter.module.courseId, db);
  if (lesson!.contentType !== 'QUIZ') notFound('Quiz');
  return lesson!;
}

type StudentQuizLesson = Awaited<ReturnType<typeof requireStudentQuizLesson>>;

function cannotStartReason(
  quiz: StudentQuizLesson['quiz'],
  attemptsUsed: number,
  inProgress: boolean,
): string | null {
  if (!quiz || quiz.status === 'DRAFT') return 'This quiz is not open yet.';
  if (inProgress) return null; // starting resumes the running attempt
  if (quiz.status === 'CLOSED') return 'This quiz is closed.';
  if (quiz._count.questions === 0) return 'This quiz has no questions yet.';
  if (attemptsUsed >= quiz.maxAttempts) {
    return `You have used all ${quiz.maxAttempts} attempt${quiz.maxAttempts === 1 ? '' : 's'}.`;
  }
  return null;
}

export const studentQuizService = {
  async get(auth: AuthContext, lessonId: string): Promise<StudentQuizDto> {
    const lesson = await requireStudentQuizLesson(auth, lessonId);
    const quiz = lesson.quiz;
    if (!quiz || quiz.status === 'DRAFT') {
      return {
        lessonId,
        available: false,
        cannotStartReason: 'This quiz is not open yet.',
        rules: null,
        attemptsUsed: 0,
        inProgressAttemptId: null,
        attempts: [],
      };
    }
    // Lazily finalize this student's expired attempt before reporting its state.
    await sweepExpiredAttempts({
      where: Prisma.sql`AND "quiz_id" = ${quiz.id}::uuid AND "user_id" = ${auth.userId}::uuid`,
    });
    const attempts = await prisma.assessmentAttempt.findMany({
      where: { quizId: quiz.id, userId: auth.userId },
      orderBy: { attemptNumber: 'desc' },
      select: attemptSummarySelect,
    });
    const inProgress = attempts.find((attempt) => attempt.status === 'IN_PROGRESS') ?? null;
    return {
      lessonId,
      available: true,
      cannotStartReason: cannotStartReason(quiz, attempts.length, inProgress !== null),
      rules: {
        status: quiz.status,
        timeLimitMinutes: quiz.timeLimitMinutes,
        maxAttempts: quiz.maxAttempts,
        passPercent: quiz.passPercent,
        negativeMarking: quiz.negativeMarking,
        questionsPerAttempt: Math.min(
          quiz.questionsPerAttempt ?? quiz._count.questions,
          quiz._count.questions,
        ),
        showResultImmediately: quiz.showResultImmediately,
        answerReveal: quiz.answerReveal,
      },
      attemptsUsed: attempts.length,
      inProgressAttemptId: inProgress?.id ?? null,
      attempts: attempts.map(toStudentSummary),
    };
  },

  /**
   * Starts an attempt — or returns the student's running one (idempotent under retries and
   * concurrent clicks). The attempt limit is checked under a per-student advisory lock.
   */
  async start(auth: AuthContext, lessonId: string): Promise<AttemptStartDto> {
    try {
      return await prisma.$transaction(async (tx) => {
        const lesson = await requireStudentQuizLesson(auth, lessonId, tx);
        const quiz = lesson.quiz;
        if (!quiz || quiz.status === 'DRAFT')
          throw new AppError('CONFLICT', 'This quiz is not open yet.');
        await lockStudentAssessment(tx, quiz.id, auth.userId);
        const now = clock.now();

        const existing = await tx.assessmentAttempt.findMany({
          where: { quizId: quiz.id, userId: auth.userId },
          select: { id: true, status: true },
        });
        const running = existing.find((attempt) => attempt.status === 'IN_PROGRESS');
        if (running) {
          const locked = await lockAttempt(tx, running.id);
          const row = await expireIfDue(tx, locked!, now);
          if (row.status === 'IN_PROGRESS')
            return { resumed: true, attempt: toStudentAttempt(row, now) };
        }
        const reason = cannotStartReason(lesson.quiz, existing.length, false);
        if (reason) throw new AppError('CONFLICT', reason);

        const questions = await tx.assessmentQuestion.findMany({
          where: { quizId: quiz.id },
          select: sourceQuestionSelect,
        });
        if (questions.length === 0)
          throw new AppError('CONFLICT', 'This quiz has no questions yet.');
        const chosen = selectQuestions(
          questions,
          {
            shuffleQuestions: quiz.shuffleQuestions,
            shuffleOptions: quiz.shuffleOptions,
            take: quiz.questionsPerAttempt,
          },
          await questionImageRefs(tx, questions),
        );
        const maxCents = chosen.reduce((sum, q) => sum + toCents(q.marks), 0);
        const created = await tx.assessmentAttempt.create({
          data: {
            quizId: quiz.id,
            userId: auth.userId,
            attemptNumber: existing.length + 1,
            startedAt: now,
            deadlineAt: quiz.timeLimitMinutes
              ? new Date(now.getTime() + quiz.timeLimitMinutes * 60_000)
              : null,
            maxScore: new Prisma.Decimal(fromCents(maxCents).toFixed(2)),
            questions: { create: chosen },
          },
          select: { id: true },
        });
        const row = (await findAttempt(tx, created.id))!;
        return { resumed: false, attempt: toStudentAttempt(row, now) };
      });
    } catch (error) {
      return rethrowAttemptRace(error);
    }
  },
};
