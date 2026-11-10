import {
  PERMISSIONS,
  type AttemptStartDto,
  type ExamAvailability,
  type FacultyExamDetail,
  type FacultyExamItem,
  type Paginated,
  type QuestionDto,
  type StudentExamDetail,
  type StudentExamItem,
} from '@asra/types';
import type {
  AssessmentTransition,
  ExamCreateInput,
  ExamUpdateInput,
  FacultyExamListQuery,
  QuestionInput,
  QuestionOrderInput,
  StudentExamListQuery,
} from '@asra/validation';
import { prisma } from '../../database/prisma.js';
import type { DbClient } from '../../database/types.js';
import { Prisma } from '../../generated/prisma/client.js';
import { clock } from '../../lib/clock.js';
import { accessPolicy } from '../../services/access-policy.service.js';
import type { AuthContext } from '../../types/auth.js';
import { AppError, fieldError } from '../../utils/app-error.js';
import { pageArgs, paginated } from '../../utils/pagination.js';
import {
  attemptCounts,
  attemptSummarySelect,
  emptyCounts,
  expireIfDue,
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
  mediaUsedBy,
  questionAuthoring,
  releaseMediaSafely,
  questionTotals,
  type OwnerContext,
} from './questions.service.js';
import { fromCents, toCents } from './scoring.js';

/**
 * Examinations (PHASE 09, docs/ASSESSMENTS.md §7). The SERVER is authoritative for every timing
 * decision: availability is judged with `clock.now()`, the attempt deadline is computed once at
 * start by `examAttemptDeadline` and persisted, and every later read/save/submit is checked against
 * that stored deadline. Nothing the browser sends (times, durations, remaining seconds) is used.
 */

/** An attempt may not start with less than this much time left before the exam closes. */
export const EXAM_MIN_START_REMAINING_MS = 60_000;

/**
 * THE deadline rule: the earlier of (start + duration) and the exam's closing time. Pure, so the
 * policy is unit-tested directly.
 */
export function examAttemptDeadline(
  startedAt: Date,
  exam: { durationMinutes: number; closesAt: Date },
): Date {
  const byDuration = startedAt.getTime() + exam.durationMinutes * 60_000;
  return new Date(Math.min(byDuration, exam.closesAt.getTime()));
}

export function examAvailability(
  exam: { status: string; opensAt: Date; closesAt: Date },
  now: Date,
): ExamAvailability {
  if (exam.status === 'CLOSED' || now >= exam.closesAt) return 'CLOSED';
  return now < exam.opensAt ? 'UPCOMING' : 'OPEN';
}

const notFound = (entity: string): never => {
  throw new AppError('NOT_FOUND', `${entity} not found`);
};

const examSelect = {
  id: true,
  courseId: true,
  title: true,
  instructions: true,
  status: true,
  opensAt: true,
  closesAt: true,
  durationMinutes: true,
  maxAttempts: true,
  passPercent: true,
  negativeMarking: true,
  shuffleQuestions: true,
  shuffleOptions: true,
  answerReveal: true,
  resultsPublishedAt: true,
  publishedAt: true,
  closedAt: true,
  updatedAt: true,
  course: { select: { id: true, title: true } },
} satisfies Prisma.ExaminationSelect;

type ExamRow = Prisma.ExaminationGetPayload<{ select: typeof examSelect }>;

async function decorate(rows: ExamRow[]): Promise<FacultyExamItem[]> {
  const ids = rows.map((row) => row.id);
  const [totals, counts] = await Promise.all([
    ids.length ? questionTotals({ examinationId: { in: ids } }, 'examinationId') : new Map(),
    attemptCounts({ examinationId: { in: ids } }),
  ]);
  return rows.map((row) => {
    const total = totals.get(row.id) ?? { count: 0, marks: 0 };
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      course: row.course,
      opensAt: row.opensAt.toISOString(),
      closesAt: row.closesAt.toISOString(),
      durationMinutes: row.durationMinutes,
      maxAttempts: row.maxAttempts,
      passPercent: row.passPercent,
      negativeMarking: row.negativeMarking,
      shuffleQuestions: row.shuffleQuestions,
      shuffleOptions: row.shuffleOptions,
      answerReveal: row.answerReveal,
      resultsPublishedAt: row.resultsPublishedAt?.toISOString() ?? null,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      questionCount: total.count,
      totalMarks: total.marks,
      attempts: counts.get(row.id) ?? emptyCounts(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

async function authorisedExam(
  auth: AuthContext,
  id: string,
  permission: (typeof PERMISSIONS)[keyof typeof PERMISSIONS] = PERMISSIONS.CONTENT_MANAGE_ASSIGNED,
  db: DbClient = prisma,
): Promise<ExamRow> {
  const row =
    (await db.examination.findUnique({ where: { id }, select: examSelect })) ?? notFound('Exam');
  await accessPolicy.assertTeachesCourse(auth, row.courseId, permission, db);
  return row;
}

async function lockExam(tx: DbClient, id: string): Promise<ExamRow> {
  await tx.$queryRaw`SELECT "id" FROM "examinations" WHERE "id" = ${id}::uuid FOR UPDATE`;
  return tx.examination.findUniqueOrThrow({ where: { id }, select: examSelect });
}

const ownerResolver =
  (auth: AuthContext, id: string) =>
  async (tx: DbClient): Promise<OwnerContext> => {
    const exam = await authorisedExam(auth, id, undefined, tx);
    return {
      owner: { examinationId: exam.id },
      courseId: exam.courseId,
      status: exam.status,
      kind: 'EXAM',
    };
  };

function assertFutureClose(closesAt: Date, now: Date) {
  if (closesAt <= now) {
    throw fieldError('VALIDATION_ERROR', 'closesAt', 'The closing time must be in the future');
  }
}

const sweepExam = (examId: string) =>
  sweepExpiredAttempts({ where: Prisma.sql`AND "examination_id" = ${examId}::uuid` });

// --- Faculty --------------------------------------------------------------------------------

export const facultyExamService = {
  async list(auth: AuthContext, query: FacultyExamListQuery): Promise<Paginated<FacultyExamItem>> {
    let ids = await accessPolicy.taughtCourseIds(auth, PERMISSIONS.CONTENT_MANAGE_ASSIGNED);
    if (query.courseId) {
      if (!ids.includes(query.courseId))
        throw new AppError('FORBIDDEN', 'You are not assigned to this course');
      ids = [query.courseId];
    }
    if (ids.length === 0) return paginated([], 0, query);
    const where: Prisma.ExaminationWhereInput = { courseId: { in: ids } };
    const { skip, take } = pageArgs(query);
    const [rows, total] = await Promise.all([
      prisma.examination.findMany({
        where,
        select: examSelect,
        orderBy: [{ opensAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      prisma.examination.count({ where }),
    ]);
    return paginated(await decorate(rows), total, query);
  },

  async detail(auth: AuthContext, id: string): Promise<FacultyExamDetail> {
    const row = await authorisedExam(auth, id);
    await sweepExam(id);
    const [item] = await decorate([row]);
    const [questions, activeStudents] = await Promise.all([
      listQuestions({ examinationId: id }),
      prisma.enrollment.count({ where: { courseId: row.courseId, status: 'ACTIVE' } }),
    ]);
    const now = clock.now();
    return {
      ...item!,
      instructions: row.instructions,
      questions,
      activeStudents,
      windowEnded: row.status === 'CLOSED' || now >= row.closesAt,
    };
  },

  async create(
    auth: AuthContext,
    courseId: string,
    input: ExamCreateInput,
  ): Promise<FacultyExamDetail> {
    const course = await prisma.course.findUnique({
      where: { id: courseId },
      select: { status: true },
    });
    if (!course) notFound('Course');
    await accessPolicy.assertTeachesCourse(auth, courseId, PERMISSIONS.CONTENT_MANAGE_ASSIGNED);
    if (course!.status === 'ARCHIVED')
      throw new AppError('CONFLICT', 'Exams cannot be added to an archived course.');
    assertFutureClose(new Date(input.closesAt), clock.now());
    const exam = await prisma.examination.create({
      data: {
        courseId,
        title: input.title,
        instructions: input.instructions ?? null,
        opensAt: new Date(input.opensAt),
        closesAt: new Date(input.closesAt),
        durationMinutes: input.durationMinutes,
        maxAttempts: input.maxAttempts,
        passPercent: input.passPercent,
        negativeMarking: input.negativeMarking,
        shuffleQuestions: input.shuffleQuestions,
        shuffleOptions: input.shuffleOptions,
        answerReveal: input.answerReveal,
        createdById: auth.userId,
      },
      select: { id: true },
    });
    return facultyExamService.detail(auth, exam.id);
  },

  /** Changes a DRAFT exam. Published exams keep their schedule and rules (fairness). */
  async update(auth: AuthContext, id: string, input: ExamUpdateInput): Promise<FacultyExamDetail> {
    await prisma.$transaction(async (tx) => {
      await authorisedExam(auth, id, undefined, tx);
      const current = await lockExam(tx, id);
      if (current.status !== 'DRAFT') {
        throw new AppError(
          'CONFLICT',
          'A published exam cannot be changed. Unpublish it first (possible only before anyone has attempted it).',
        );
      }
      const opensAt = input.opensAt ? new Date(input.opensAt) : current.opensAt;
      const closesAt = input.closesAt ? new Date(input.closesAt) : current.closesAt;
      if (closesAt <= opensAt)
        throw fieldError('VALIDATION_ERROR', 'closesAt', 'The exam must close after it opens');
      if (input.closesAt) assertFutureClose(closesAt, clock.now());
      await tx.examination.update({
        where: { id },
        data: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
          opensAt,
          closesAt,
          ...(input.durationMinutes === undefined
            ? {}
            : { durationMinutes: input.durationMinutes }),
          ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
          ...(input.passPercent === undefined ? {} : { passPercent: input.passPercent }),
          ...(input.negativeMarking === undefined
            ? {}
            : { negativeMarking: input.negativeMarking }),
          ...(input.shuffleQuestions === undefined
            ? {}
            : { shuffleQuestions: input.shuffleQuestions }),
          ...(input.shuffleOptions === undefined ? {} : { shuffleOptions: input.shuffleOptions }),
          ...(input.answerReveal === undefined ? {} : { answerReveal: input.answerReveal }),
        },
      });
    });
    return facultyExamService.detail(auth, id);
  },

  /** Deletes a DRAFT exam (drafts never have attempts). */
  async remove(auth: AuthContext, id: string): Promise<void> {
    const removedMedia = await prisma.$transaction(async (tx) => {
      await authorisedExam(auth, id, undefined, tx);
      const current = await lockExam(tx, id);
      if (current.status !== 'DRAFT') {
        throw new AppError(
          'CONFLICT',
          'Only a draft exam can be deleted. Close a published exam instead.',
        );
      }
      const media = await mediaUsedBy(tx, { examinationId: id });
      await tx.examination.delete({ where: { id } });
      return media;
    });
    // Images no other question/attempt uses are removed from storage (after commit).
    await releaseMediaSafely(removedMedia);
  },

  addQuestion(auth: AuthContext, id: string, input: QuestionInput): Promise<QuestionDto> {
    return questionAuthoring.add(auth, ownerResolver(auth, id), input);
  },

  reorderQuestions(auth: AuthContext, id: string, input: QuestionOrderInput) {
    return questionAuthoring.reorder(ownerResolver(auth, id), input);
  },

  async transition(
    auth: AuthContext,
    id: string,
    action: AssessmentTransition,
  ): Promise<FacultyExamDetail> {
    let deliveries: string[] = [];
    await prisma.$transaction(async (tx) => {
      await authorisedExam(auth, id, undefined, tx);
      const current = await lockExam(tx, id);
      const now = clock.now();
      const refuse = (message: string): never => {
        throw new AppError('CONFLICT', message);
      };
      switch (action) {
        case 'publish': {
          if (current.status !== 'DRAFT')
            refuse(`Only a draft exam can be published (it is ${current.status.toLowerCase()}).`);
          const count = await tx.assessmentQuestion.count({ where: { examinationId: id } });
          if (count === 0) refuse('Add at least one question before publishing.');
          assertFutureClose(current.closesAt, now);
          await tx.examination.update({
            where: { id },
            data: { status: 'PUBLISHED', publishedAt: now, closedAt: null },
          });
          // PHASE 11: students of the (published) course hear about the exam once.
          deliveries = await notificationProducers.examPublished(tx, id);
          break;
        }
        case 'close': {
          if (current.status !== 'PUBLISHED') refuse('Only a published exam can be closed.');
          // No new attempts; running attempts keep their (already capped) deadlines.
          await tx.examination.update({ where: { id }, data: { status: 'CLOSED', closedAt: now } });
          break;
        }
        case 'reopen': {
          if (current.status !== 'CLOSED') refuse('Only a closed exam can be reopened.');
          if (current.resultsPublishedAt)
            refuse('Results of this exam are published, so it cannot be reopened.');
          if (now >= current.closesAt)
            refuse('The exam window has ended, so it cannot be reopened.');
          await tx.examination.update({
            where: { id },
            data: { status: 'PUBLISHED', closedAt: null },
          });
          break;
        }
        case 'unpublish': {
          if (current.status !== 'PUBLISHED')
            refuse('Only a published exam can be moved back to draft.');
          const attempts = await tx.assessmentAttempt.count({ where: { examinationId: id } });
          if (attempts > 0)
            refuse(
              'Students have already attempted this exam, so it cannot go back to draft. Close it instead.',
            );
          await tx.examination.update({
            where: { id },
            data: { status: 'DRAFT', publishedAt: null },
          });
          break;
        }
      }
      const actions = {
        publish: 'exam.published',
        close: 'exam.closed',
        reopen: 'exam.reopened',
        unpublish: 'exam.unpublished',
      } as const;
      await audit(tx, {
        action: actions[action],
        actorId: auth.userId,
        entityType: 'examination',
        entityId: id,
      });
    });
    dispatchAfterCommit(deliveries);
    return facultyExamService.detail(auth, id);
  },

  /**
   * Releases results to students. Only after the window has ended (or the exam is closed), once
   * every attempt is finalized and every written answer is graded — never a partial or provisional
   * result. Idempotent.
   */
  async publishResults(
    auth: AuthContext,
    id: string,
  ): Promise<{ published: boolean; exam: FacultyExamDetail }> {
    await authorisedExam(auth, id, PERMISSIONS.SUBMISSIONS_GRADE_ASSIGNED);
    await sweepExam(id);
    let deliveries: string[] = [];
    const published = await prisma.$transaction(async (tx) => {
      const current = await lockExam(tx, id);
      if (current.resultsPublishedAt) return false;
      const now = clock.now();
      if (current.status === 'DRAFT')
        throw new AppError('CONFLICT', 'A draft exam has no results to publish.');
      if (current.status !== 'CLOSED' && now < current.closesAt) {
        throw new AppError(
          'CONFLICT',
          'Results can be published once the exam window has ended or the exam is closed.',
        );
      }
      const [running, pending] = await Promise.all([
        tx.assessmentAttempt.count({ where: { examinationId: id, status: 'IN_PROGRESS' } }),
        tx.assessmentAttempt.count({ where: { examinationId: id, evaluationStatus: 'PENDING' } }),
      ]);
      if (running > 0) {
        throw new AppError(
          'CONFLICT',
          `${running} attempt${running === 1 ? ' is' : 's are'} still running. Publish results after they finish.`,
        );
      }
      if (pending > 0) {
        throw new AppError(
          'CONFLICT',
          `${pending} attempt${pending === 1 ? ' has' : 's have'} written answers awaiting grading. Grade them first.`,
        );
      }
      await tx.examination.update({ where: { id }, data: { resultsPublishedAt: now } });
      await audit(tx, {
        action: 'exam.results_published',
        actorId: auth.userId,
        entityType: 'examination',
        entityId: id,
      });
      // PHASE 11: students who attempted it (and can still access the course) are notified.
      deliveries = await notificationProducers.examResultsPublished(tx, id);
      return true;
    });
    dispatchAfterCommit(deliveries);
    return { published, exam: await facultyExamService.detail(auth, id) };
  },

  /** Finalizes this exam's attempts whose deadline has passed; returns how many. */
  async processExpired(auth: AuthContext, id: string): Promise<{ finalized: number }> {
    await authorisedExam(auth, id, PERMISSIONS.SUBMISSIONS_GRADE_ASSIGNED);
    return { finalized: await sweepExam(id) };
  },

  async examIdForGrading(auth: AuthContext, id: string): Promise<string> {
    return (await authorisedExam(auth, id, PERMISSIONS.SUBMISSIONS_GRADE_ASSIGNED)).id;
  },
};

// --- Student --------------------------------------------------------------------------------

/** A published/closed exam of a course the student can access (drafts are 404). */
async function requireStudentExam(auth: AuthContext, id: string, db: DbClient = prisma) {
  const exam = await db.examination.findUnique({ where: { id }, select: examSelect });
  if (!exam || exam.status === 'DRAFT') notFound('Exam');
  await accessPolicy.assertCanViewCourseContent(auth, exam!.courseId, db);
  return exam!;
}

function cannotStartReason(
  exam: ExamRow,
  now: Date,
  attemptsUsed: number,
  questionCount: number,
  inProgress: boolean,
): string | null {
  if (inProgress) return null; // starting resumes the running attempt
  const availability = examAvailability(exam, now);
  if (availability === 'UPCOMING') return 'This exam has not opened yet.';
  if (availability === 'CLOSED') return 'This exam is closed.';
  if (exam.closesAt.getTime() - now.getTime() < EXAM_MIN_START_REMAINING_MS) {
    return 'The exam closes in less than a minute, so a new attempt cannot start.';
  }
  if (attemptsUsed >= exam.maxAttempts) {
    return `You have used all ${exam.maxAttempts} attempt${exam.maxAttempts === 1 ? '' : 's'}.`;
  }
  if (questionCount === 0) return 'This exam has no questions.';
  return null;
}

async function studentItems(
  auth: AuthContext,
  rows: ExamRow[],
  now: Date,
): Promise<StudentExamItem[]> {
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return [];
  const [totals, attempts] = await Promise.all([
    questionTotals({ examinationId: { in: ids } }, 'examinationId'),
    prisma.assessmentAttempt.findMany({
      where: { examinationId: { in: ids }, userId: auth.userId },
      select: { id: true, examinationId: true, status: true },
    }),
  ]);
  return rows.map((row) => {
    const mine = attempts.filter((attempt) => attempt.examinationId === row.id);
    const total = totals.get(row.id) ?? { count: 0, marks: 0 };
    return {
      id: row.id,
      title: row.title,
      course: row.course,
      opensAt: row.opensAt.toISOString(),
      closesAt: row.closesAt.toISOString(),
      durationMinutes: row.durationMinutes,
      maxAttempts: row.maxAttempts,
      availability: examAvailability(row, now),
      attemptsUsed: mine.length,
      inProgressAttemptId: mine.find((attempt) => attempt.status === 'IN_PROGRESS')?.id ?? null,
      resultsPublished: row.resultsPublishedAt !== null,
      questionCount: total.count,
      maxScore: total.marks,
    };
  });
}

export const studentExamService = {
  /** Exams of the student's accessible courses: `current` = open or upcoming, `past` = closed. */
  async list(auth: AuthContext, query: StudentExamListQuery): Promise<Paginated<StudentExamItem>> {
    accessPolicy.assertPermission(auth, PERMISSIONS.CONTENT_VIEW_ENROLLED);
    const now = clock.now();
    await sweepExpiredAttempts({
      where: Prisma.sql`AND "user_id" = ${auth.userId}::uuid AND "examination_id" IS NOT NULL`,
    });
    const base: Prisma.ExaminationWhereInput = {
      status: { in: ['PUBLISHED', 'CLOSED'] },
      course: {
        status: 'PUBLISHED',
        enrollments: { some: { userId: auth.userId, status: 'ACTIVE' } },
      },
    };
    const where: Prisma.ExaminationWhereInput =
      query.when === 'current'
        ? { ...base, status: 'PUBLISHED', closesAt: { gt: now } }
        : { ...base, OR: [{ status: 'CLOSED' }, { closesAt: { lte: now } }] };
    const { skip, take } = pageArgs(query);
    const [rows, total] = await Promise.all([
      prisma.examination.findMany({
        where,
        select: examSelect,
        orderBy:
          query.when === 'current'
            ? [{ opensAt: 'asc' }, { id: 'asc' }]
            : [{ closesAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      prisma.examination.count({ where }),
    ]);
    return paginated(await studentItems(auth, rows, now), total, query);
  },

  async detail(auth: AuthContext, id: string): Promise<StudentExamDetail> {
    const exam = await requireStudentExam(auth, id);
    await sweepExpiredAttempts({
      where: Prisma.sql`AND "examination_id" = ${id}::uuid AND "user_id" = ${auth.userId}::uuid`,
    });
    const now = clock.now();
    const [[item], attempts, written] = await Promise.all([
      studentItems(auth, [exam], now),
      prisma.assessmentAttempt.findMany({
        where: { examinationId: id, userId: auth.userId },
        orderBy: { attemptNumber: 'desc' },
        select: attemptSummarySelect,
      }),
      prisma.assessmentQuestion.count({ where: { examinationId: id, type: 'SHORT_ANSWER' } }),
    ]);
    return {
      ...item!,
      instructions: exam.instructions,
      passPercent: exam.passPercent,
      negativeMarking: exam.negativeMarking,
      hasWrittenQuestions: written > 0,
      cannotStartReason: cannotStartReason(
        exam,
        now,
        item!.attemptsUsed,
        item!.questionCount,
        item!.inProgressAttemptId !== null,
      ),
      serverNow: now.toISOString(),
      attempts: attempts.map(toStudentSummary),
    };
  },

  /**
   * Starts (or resumes) an attempt. Server-side rules, in order: published + accessible; running
   * attempt → resumed; window open [opensAt, closesAt) with ≥ 1 minute left; attempts left;
   * questions exist. Start time = server now; deadline = examAttemptDeadline(now, exam).
   */
  async start(auth: AuthContext, id: string): Promise<AttemptStartDto> {
    try {
      return await prisma.$transaction(async (tx) => {
        await requireStudentExam(auth, id, tx);
        await lockStudentAssessment(tx, id, auth.userId);
        const exam = await tx.examination.findUniqueOrThrow({ where: { id }, select: examSelect });
        const now = clock.now();
        const existing = await tx.assessmentAttempt.findMany({
          where: { examinationId: id, userId: auth.userId },
          select: { id: true, status: true },
        });
        const running = existing.find((attempt) => attempt.status === 'IN_PROGRESS');
        if (running) {
          const locked = await lockAttempt(tx, running.id);
          const row = await expireIfDue(tx, locked!, now);
          if (row.status === 'IN_PROGRESS')
            return { resumed: true, attempt: toStudentAttempt(row, now) };
        }
        const questions = await tx.assessmentQuestion.findMany({
          where: { examinationId: id },
          select: sourceQuestionSelect,
        });
        const reason = cannotStartReason(exam, now, existing.length, questions.length, false);
        if (reason) throw new AppError('CONFLICT', reason);
        const chosen = selectQuestions(
          questions,
          {
            shuffleQuestions: exam.shuffleQuestions,
            shuffleOptions: exam.shuffleOptions,
            take: null,
          },
          await questionImageRefs(tx, questions),
        );
        const maxCents = chosen.reduce((sum, q) => sum + toCents(q.marks), 0);
        const created = await tx.assessmentAttempt.create({
          data: {
            examinationId: id,
            userId: auth.userId,
            attemptNumber: existing.length + 1,
            startedAt: now,
            deadlineAt: examAttemptDeadline(now, exam),
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
