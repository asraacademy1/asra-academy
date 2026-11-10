import {
  PERMISSIONS,
  type AnswerSaveResultDto,
  type FacultyAttemptDetail,
  type FacultyAttemptItem,
  type Paginated,
  type StudentAssessmentResultItem,
  type StudentAttemptDto,
} from '@asra/types';
import type {
  AnswerGradeInput,
  AnswerSaveInput,
  AttemptListQuery,
  PaginationQuery,
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
  assessmentOf,
  attemptSummarySelect,
  finalizeLocked,
  findAttempt,
  isExpired,
  loadWithExpiry,
  lockAttempt,
  readSnapshot,
  reevaluateLocked,
  scoreOf,
  sweepExpiredAttempts,
  toFacultyDetail,
  toFacultyItem,
  toStudentAttempt,
  type AttemptRow,
} from './attempts.core.js';
import { audit } from './audit.js';
import { isAnswered, toCents } from './scoring.js';

/**
 * Attempt operations shared by quizzes and examinations (docs/ASSESSMENTS.md §5–§8).
 *
 * Student side: an attempt is only ever found through its owner — another student's attempt id is
 * a 404, not a 403, so ids cannot be probed. Faculty side: the course is resolved from the attempt
 * (attempt → quiz → lesson → … → course, or attempt → exam → course) and `assertTeachesCourse`
 * with `submissions.grade_assigned` is required.
 */

const attemptNotFound = (): never => {
  throw new AppError('NOT_FOUND', 'Attempt not found');
};

/**
 * Owner check WITHOUT loading or locking anything else (and without revealing existence). These
 * are the COURSE quiz/exam routes: an academy-quiz attempt is a 404 here (it has its own routes
 * and access rules), so the two can never be mixed.
 */
async function assertOwnAttempt(auth: AuthContext, id: string, db: DbClient = prisma) {
  const owner = await db.assessmentAttempt.findUnique({
    where: { id },
    select: { userId: true, academyQuizId: true },
  });
  if (!owner || owner.userId !== auth.userId || owner.academyQuizId !== null) attemptNotFound();
}

export function validateAnswer(question: AttemptRow['questions'][number], input: AnswerSaveInput) {
  if (question.type === 'SHORT_ANSWER') {
    if (input.textAnswer === undefined) {
      throw fieldError('VALIDATION_ERROR', 'textAnswer', 'This question needs a written answer');
    }
    const text = input.textAnswer ?? '';
    return { selectedOptionIds: [] as string[], textAnswer: text.trim() === '' ? null : text };
  }
  if (input.selectedOptionIds === undefined) {
    throw fieldError('VALIDATION_ERROR', 'selectedOptionIds', 'Choose an option');
  }
  const known = new Set(readSnapshot(question.snapshot).options.map((option) => option.id));
  if (input.selectedOptionIds.some((id) => !known.has(id))) {
    throw fieldError(
      'VALIDATION_ERROR',
      'selectedOptionIds',
      'That option does not belong to this question',
    );
  }
  if (question.type !== 'MULTIPLE_CHOICE' && input.selectedOptionIds.length > 1) {
    throw fieldError('VALIDATION_ERROR', 'selectedOptionIds', 'Choose only one option');
  }
  return { selectedOptionIds: input.selectedOptionIds, textAnswer: null };
}

export const FINAL_MESSAGE =
  'This attempt has already been submitted, so its answers can no longer change.';
export const EXPIRED_MESSAGE =
  'Time is up. Your answers saved before the deadline have been submitted automatically.';

// --- Student --------------------------------------------------------------------------------

export const studentAttemptService = {
  async get(auth: AuthContext, id: string): Promise<StudentAttemptDto> {
    await assertOwnAttempt(auth, id);
    const now = clock.now();
    const row = (await loadWithExpiry(id, now)) ?? attemptNotFound();
    return toStudentAttempt(row, now);
  },

  /**
   * Stores one answer. Accepted only if, at SERVER time, the attempt is IN_PROGRESS and its
   * deadline has not passed; the attempt row is locked so the save and a concurrent submission or
   * expiry are strictly ordered. The response is sent only after the answer is committed.
   */
  async saveAnswer(
    auth: AuthContext,
    id: string,
    questionId: string,
    input: AnswerSaveInput,
  ): Promise<AnswerSaveResultDto> {
    const outcome = await prisma.$transaction(async (tx) => {
      await assertOwnAttempt(auth, id, tx);
      const row = (await lockAttempt(tx, id)) ?? attemptNotFound();
      const now = clock.now();
      if (row.status !== 'IN_PROGRESS') return { kind: 'final' as const, status: row.status };
      if (isExpired(row, now)) {
        await finalizeLocked(tx, row, 'EXPIRED', now, null);
        return { kind: 'expired' as const, status: 'EXPIRED' as const };
      }
      await accessPolicy.assertCanViewCourseContent(auth, assessmentOf(row).course.id, tx);
      const question = row.questions.find((q) => q.id === questionId);
      if (!question) throw new AppError('NOT_FOUND', 'Question not found in this attempt');
      const answer = validateAnswer(question, input);
      const base = {
        attemptId: id,
        questionId,
        status: row.status,
        deadlineAt: row.deadlineAt?.toISOString() ?? null,
        serverNow: now.toISOString(),
      };
      if (input.sequence <= question.answerSequence) {
        return {
          kind: 'saved' as const,
          dto: { ...base, applied: false, answerSequence: question.answerSequence },
        };
      }
      const answered = isAnswered({ type: question.type, ...answer });
      await tx.attemptQuestion.update({
        where: { id: questionId },
        data: {
          selectedOptionIds: answer.selectedOptionIds,
          textAnswer: answer.textAnswer,
          answerSequence: input.sequence,
          answeredAt: answered ? now : null,
        },
      });
      return {
        kind: 'saved' as const,
        dto: { ...base, applied: true, answerSequence: input.sequence },
      };
    });
    if (outcome.kind === 'final') {
      throw new AppError('CONFLICT', FINAL_MESSAGE, { attemptStatus: outcome.status });
    }
    if (outcome.kind === 'expired') {
      throw new AppError('CONFLICT', EXPIRED_MESSAGE, { attemptStatus: outcome.status });
    }
    return outcome.dto;
  },

  /**
   * Finalizes the attempt from the answers ALREADY stored on the server (the request has no body).
   * Before the deadline → SUBMITTED at server time; at/after it → EXPIRED with the answers saved in
   * time. Repeating the request (retry, double click, second tab) returns the same final attempt
   * without evaluating it again.
   */
  async submit(
    auth: AuthContext,
    id: string,
  ): Promise<{ outcome: 'submitted' | 'expired' | 'already_final'; attempt: StudentAttemptDto }> {
    return prisma.$transaction(async (tx) => {
      await assertOwnAttempt(auth, id, tx);
      const row = (await lockAttempt(tx, id)) ?? attemptNotFound();
      const now = clock.now();
      if (row.status !== 'IN_PROGRESS') {
        return { outcome: 'already_final' as const, attempt: toStudentAttempt(row, now) };
      }
      const mode = isExpired(row, now) ? ('EXPIRED' as const) : ('SUBMITTED' as const);
      const finalized = await finalizeLocked(tx, row, mode, now, auth.userId);
      return {
        outcome: mode === 'EXPIRED' ? ('expired' as const) : ('submitted' as const),
        attempt: toStudentAttempt(finalized, now),
      };
    });
  },

  /**
   * The student's released quiz/exam results, newest first. The filter is the same release rule
   * as `resultStateOf` (evaluated AND results visible), expressed in SQL.
   */
  async results(
    auth: AuthContext,
    query: PaginationQuery,
  ): Promise<Paginated<StudentAssessmentResultItem>> {
    await sweepExpiredAttempts({ where: Prisma.sql`AND "user_id" = ${auth.userId}::uuid` });
    const where: Prisma.AssessmentAttemptWhereInput = {
      userId: auth.userId,
      status: { in: ['SUBMITTED', 'EXPIRED'] },
      evaluationStatus: 'EVALUATED',
      OR: [
        { quiz: { OR: [{ showResultImmediately: true }, { resultsPublishedAt: { not: null } }] } },
        { examination: { resultsPublishedAt: { not: null } } },
      ],
    };
    const { skip, take } = pageArgs(query);
    const [rows, total] = await Promise.all([
      prisma.assessmentAttempt.findMany({
        where,
        select: attemptSummarySelect,
        orderBy: [{ submittedAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      prisma.assessmentAttempt.count({ where }),
    ]);
    return paginated(
      rows.map((row) => {
        const assessment = assessmentOf(row);
        return {
          attemptId: row.id,
          kind: assessment.kind,
          title: assessment.title,
          course: assessment.course,
          lessonId: assessment.lessonId,
          attemptNumber: row.attemptNumber,
          submittedAt: row.submittedAt!.toISOString(),
          result: scoreOf(row)!,
        };
      }),
      total,
      query,
    );
  },
};

// --- Faculty --------------------------------------------------------------------------------

async function authorisedAttempt(auth: AuthContext, id: string, db: DbClient = prisma) {
  const row = (await findAttempt(db, id)) ?? attemptNotFound();
  // Faculty review covers course quizzes/exams only; academy attempts are not theirs to see.
  if (row.academyQuizId !== null) attemptNotFound();
  await accessPolicy.assertTeachesCourse(
    auth,
    assessmentOf(row).course.id,
    PERMISSIONS.SUBMISSIONS_GRADE_ASSIGNED,
    db,
  );
  return row;
}

export const facultyAttemptService = {
  /** Attempts of one quiz or exam (the caller's access was checked by the owning service). */
  async list(
    where: { quizId: string } | { examinationId: string },
    query: AttemptListQuery,
  ): Promise<Paginated<FacultyAttemptItem>> {
    await sweepExpiredAttempts({
      where:
        'quizId' in where
          ? Prisma.sql`AND "quiz_id" = ${where.quizId}::uuid`
          : Prisma.sql`AND "examination_id" = ${where.examinationId}::uuid`,
    });
    const filter: Prisma.AssessmentAttemptWhereInput = {
      ...where,
      ...(query.status === 'IN_PROGRESS' ? { status: 'IN_PROGRESS' } : {}),
      ...(query.status === 'PENDING_EVALUATION' ? { evaluationStatus: 'PENDING' } : {}),
      ...(query.status === 'EVALUATED' ? { evaluationStatus: 'EVALUATED' } : {}),
    };
    const { skip, take } = pageArgs(query);
    const [rows, total] = await Promise.all([
      prisma.assessmentAttempt.findMany({
        where: filter,
        select: attemptSummarySelect,
        orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      prisma.assessmentAttempt.count({ where: filter }),
    ]);
    return paginated(rows.map(toFacultyItem), total, query);
  },

  async detail(auth: AuthContext, id: string): Promise<FacultyAttemptDetail> {
    await authorisedAttempt(auth, id);
    const row = (await loadWithExpiry(id)) ?? attemptNotFound();
    return toFacultyDetail(row);
  },

  /**
   * Manual marks for one written (SHORT_ANSWER) answer of a finalized attempt. Allowed — and
   * re-gradable, with every change audited — until the assessment's results are published; then
   * the result is final. When the last written answer is graded the attempt becomes EVALUATED.
   */
  async gradeAnswer(
    auth: AuthContext,
    attemptQuestionId: string,
    input: AnswerGradeInput,
  ): Promise<FacultyAttemptDetail> {
    const ref = await prisma.attemptQuestion.findUnique({
      where: { id: attemptQuestionId },
      select: { attemptId: true },
    });
    if (!ref) throw new AppError('NOT_FOUND', 'Answer not found');
    return prisma.$transaction(async (tx) => {
      await authorisedAttempt(auth, ref.attemptId, tx);
      let row = (await lockAttempt(tx, ref.attemptId)) ?? attemptNotFound();
      const now = clock.now();
      if (row.status === 'IN_PROGRESS') {
        if (!isExpired(row, now))
          throw new AppError('CONFLICT', 'This attempt is still in progress.');
        row = await finalizeLocked(tx, row, 'EXPIRED', now, null);
      }
      if (assessmentOf(row).resultsPublishedAt) {
        throw new AppError(
          'CONFLICT',
          'Results have been published, so marks can no longer change.',
        );
      }
      const question = row.questions.find((q) => q.id === attemptQuestionId)!;
      if (question.type !== 'SHORT_ANSWER') {
        throw new AppError('CONFLICT', 'Objective answers are scored automatically.');
      }
      if (!isAnswered(question)) {
        throw new AppError('CONFLICT', 'A blank answer scores 0 automatically.');
      }
      const max = toCents(question.marks);
      const awarded = toCents(input.awardedMarks);
      if (awarded > max) {
        throw fieldError('VALIDATION_ERROR', 'awardedMarks', `Marks cannot exceed ${max / 100}`);
      }
      const previous =
        question.gradedAt && question.awardedMarks !== null
          ? question.awardedMarks.toString()
          : null;
      await tx.attemptQuestion.update({
        where: { id: attemptQuestionId },
        data: {
          awardedMarks: new Prisma.Decimal((awarded / 100).toFixed(2)),
          penalty: new Prisma.Decimal(0),
          isCorrect: awarded === max,
          feedback: input.feedback ?? null,
          gradedById: auth.userId,
          gradedAt: now,
        },
      });
      const updated = await reevaluateLocked(tx, (await findAttempt(tx, row.id))!, now);
      await audit(tx, {
        action: 'attempt.answer_graded',
        actorId: auth.userId,
        entityType: 'attempt',
        entityId: row.id,
        data: { attemptQuestionId, awardedMarks: (awarded / 100).toFixed(2), previous },
      });
      return toFacultyDetail(updated);
    });
  },
};
